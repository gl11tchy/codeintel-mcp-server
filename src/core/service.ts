import fs from "node:fs";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";
import fg from "fast-glob";
import ignore from "ignore";
import { minimatch } from "minimatch";

import { Store } from "../db/store.js";
import { parseFile } from "../parser/extract.js";
import {
  DEFAULT_EXCLUDE_GLOBS,
  MAX_FILE_BYTES,
  ensureDir,
  estimateTokens,
  findGitRoot,
  getLine,
  getPaths,
  hashText,
  isBinaryContent,
  isSecretLikePath,
  languageFromFilePath,
  readGitRevision,
  relativeWorkspacePath,
  resolveJsImport,
  resolvePythonModule,
  stableWorkspaceId,
} from "./utils.js";
import type {
  CodeSymbol,
  Confidence,
  FileTreeNode,
  IndexedFile,
  ImportBinding,
  MetaEnvelope,
  OutlineNode,
  PaginationEnvelope,
  RawCall,
  RawReference,
  ResolvedCall,
  ResolvedReference,
  SearchSymbolFilters,
  SearchTextFilters,
  SupportedLanguage,
  SymbolSummary,
  WorkspaceConfig,
  WorkspaceRecord,
  WorkspaceSummary,
} from "../types.js";

interface WorkspaceWatchState {
  watcher: FSWatcher;
  queuedChanges: Map<string, "change" | "unlink">;
  fullRefreshQueued: boolean;
  timer: NodeJS.Timeout | null;
}

interface CandidateBinding {
  binding: ImportBinding;
  targetFilePath: string | null;
  targetSymbolId: string | null;
  confidence: Confidence;
  reason: string;
}

interface DirtyWorkspaceResult {
  changedAbsolutePaths: string[];
  removedFilePaths: string[];
}

interface IndexWorkspaceOptions {
  path: string;
  followGitignore?: boolean;
  extraExcludeGlobs?: string[];
}

function makePagination(total: number, limit: number, offset: number): PaginationEnvelope {
  const hasMore = offset + limit < total;
  return {
    total_count: total,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  };
}

function workspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    workspace_id: record.workspaceId,
    root_path: record.rootPath,
    display_name: record.displayName,
    indexed_at: record.indexedAt,
    indexed_revision: record.indexedRevision,
    file_count: record.fileCount,
    symbol_count: record.symbolCount,
    watch_status: record.watchStatus,
    watch_error: record.watchError,
  };
}

function symbolSummary(symbol: CodeSymbol): SymbolSummary {
  return {
    symbol_id: symbol.id,
    file_path: symbol.filePath,
    name: symbol.name,
    qualified_name: symbol.qualifiedName,
    kind: symbol.kind,
    language: symbol.language,
    signature: symbol.signature,
    summary: symbol.summary,
    line: symbol.line,
    end_line: symbol.endLine,
  };
}

function matchesPathGlob(filePath: string, pathGlob?: string): boolean {
  return pathGlob ? minimatch(filePath, pathGlob, { dot: true }) : true;
}

function confidenceRank(confidence: Confidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function scoreSymbol(symbol: CodeSymbol, query: string): number {
  const normalized = query.trim().toLowerCase();
  const tokens = normalized.split(/[\s._/:-]+/).filter(Boolean);
  const name = symbol.name.toLowerCase();
  const qualified = symbol.qualifiedName.toLowerCase();
  const signature = symbol.signature.toLowerCase();
  const summary = symbol.summary.toLowerCase();
  const filePath = symbol.filePath.toLowerCase();

  let score = 0;
  if (name === normalized) {
    score += 100;
  }
  if (qualified === normalized) {
    score += 95;
  }
  if (name.startsWith(normalized)) {
    score += 70;
  }
  if (qualified.includes(normalized)) {
    score += 60;
  }
  if (filePath.includes(normalized)) {
    score += 40;
  }
  if (signature.includes(normalized)) {
    score += 25;
  }
  if (summary.includes(normalized)) {
    score += 20;
  }

  for (const token of tokens) {
    if (name.includes(token)) {
      score += 12;
    }
    if (qualified.includes(token)) {
      score += 8;
    }
    if (signature.includes(token)) {
      score += 5;
    }
    if (summary.includes(token)) {
      score += 3;
    }
  }

  return score;
}

export class CodeIntelService {
  readonly store: Store;
  readonly dbPath: string;
  readonly enableWatch: boolean;
  private readonly watchStates = new Map<string, WorkspaceWatchState>();
  private _closed = false;

  constructor(options?: { dbPath?: string; enableWatch?: boolean }) {
    const paths = getPaths();
    ensureDir(paths.cache);
    ensureDir(paths.log);
    this.dbPath = options?.dbPath ?? path.join(paths.cache, "codeintel.sqlite");
    this.enableWatch = options?.enableWatch ?? true;
    this.store = new Store(this.dbPath);
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    for (const watchState of this.watchStates.values()) {
      if (watchState.timer) {
        clearTimeout(watchState.timer);
      }
      await watchState.watcher.close();
    }
    this.watchStates.clear();
    this.store.close();
  }

  async indexWorkspace(input: IndexWorkspaceOptions) {
    const workspaceRoot = findGitRoot(path.resolve(input.path));
    const workspaceId = stableWorkspaceId(workspaceRoot);
    const config: WorkspaceConfig = {
      workspaceId,
      rootPath: workspaceRoot,
      displayName: path.basename(workspaceRoot),
      followGitignore: input.followGitignore ?? true,
      extraExcludeGlobs: input.extraExcludeGlobs ?? [],
    };

    await this.performFullIndex(config);
    const record = this.requireWorkspace(workspaceId);
    return {
      workspace: workspaceSummary(record),
      languages: this.languageCounts(workspaceId),
    };
  }

  async refreshWorkspace(workspaceId: string, full = false) {
    const workspace = this.requireWorkspace(workspaceId);
    if (full) {
      await this.performFullIndex(workspace);
    } else {
      await this.performIncrementalRefresh(workspace);
    }
    const record = this.requireWorkspace(workspaceId);
    return {
      workspace: workspaceSummary(record),
      languages: this.languageCounts(workspaceId),
    };
  }

  listWorkspaces() {
    return this.store.listWorkspaces().map((record) => ({
      ...workspaceSummary(record),
      languages: this.languageCounts(record.workspaceId),
    }));
  }

  getWorkspaceStatus(workspaceId: string) {
    const workspace = this.requireWorkspace(workspaceId);
    const dirty = this.detectDirtyWorkspace(workspace);
    const currentRevision = readGitRevision(workspace.rootPath);
    return {
      workspace: workspaceSummary(workspace),
      languages: this.languageCounts(workspaceId),
      dirty: dirty.changedAbsolutePaths.length > 0 || dirty.removedFilePaths.length > 0 || currentRevision !== workspace.indexedRevision,
      pending_change_count: dirty.changedAbsolutePaths.length + dirty.removedFilePaths.length,
      pending_changed_files: dirty.changedAbsolutePaths
        .map((absolutePath) => relativeWorkspacePath(workspace.rootPath, absolutePath))
        .slice(0, 20),
      pending_removed_files: dirty.removedFilePaths.slice(0, 20),
      current_git_revision: currentRevision,
    };
  }

  getFileTree(workspaceId: string, pathPrefix?: string, maxDepth = 4, limit = 200) {
    const workspace = this.requireWorkspace(workspaceId);
    const files = this.store
      .getFileMeta(workspaceId)
      .filter((file) => (pathPrefix ? file.filePath.startsWith(pathPrefix) : true))
      .slice(0, limit);
    const symbols = this.store.getSymbols(workspaceId);
    const symbolCountByFile = new Map<string, number>();
    for (const symbol of symbols) {
      symbolCountByFile.set(symbol.filePath, (symbolCountByFile.get(symbol.filePath) ?? 0) + 1);
    }

    const root: FileTreeNode = { name: workspace.displayName, path: "", type: "directory", children: [] };
    for (const file of files) {
      const segments = file.filePath.split("/");
      let current = root;
      let currentPath = "";
      segments.forEach((segment, index) => {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        if (index + 1 > maxDepth && index < segments.length - 1) {
          return;
        }

        const existing = current.children?.find((child) => child.name === segment);
        if (existing) {
          current = existing;
          return;
        }

        const isFile = index === segments.length - 1;
        const next: FileTreeNode = isFile
          ? {
              name: segment,
              path: currentPath,
              type: "file",
              language: file.language,
              symbol_count: symbolCountByFile.get(file.filePath) ?? 0,
            }
          : {
              name: segment,
              path: currentPath,
              type: "directory",
              children: [],
            };
        current.children ??= [];
        current.children.push(next);
        current = next;
      });
    }

    return root.children ?? [];
  }

  getFileOutline(workspaceId: string, filePath: string) {
    this.requireWorkspace(workspaceId);
    const symbols = this.store.getFileSymbols(workspaceId, filePath);
    const nodesById = new Map<string, OutlineNode>();
    const roots: OutlineNode[] = [];

    for (const symbol of symbols) {
      nodesById.set(symbol.id, {
        symbol_id: symbol.id,
        name: symbol.name,
        qualified_name: symbol.qualifiedName,
        kind: symbol.kind,
        signature: symbol.signature,
        summary: symbol.summary,
        line: symbol.line,
        end_line: symbol.endLine,
        children: [],
      });
    }

    for (const symbol of symbols) {
      const node = nodesById.get(symbol.id)!;
      if (symbol.parentSymbolId && nodesById.has(symbol.parentSymbolId)) {
        nodesById.get(symbol.parentSymbolId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  searchSymbols(filters: SearchSymbolFilters) {
    this.requireWorkspace(filters.workspaceId);
    const rows = this.store.searchSymbolCandidates(filters.workspaceId, filters.query);
    const filtered = rows
      .filter((symbol) => (filters.kinds?.length ? filters.kinds.includes(symbol.kind) : true))
      .filter((symbol) => (filters.languages?.length ? filters.languages.includes(symbol.language) : true))
      .filter((symbol) => matchesPathGlob(symbol.filePath, filters.pathGlob))
      .map((symbol) => ({ symbol, score: scoreSymbol(symbol, filters.query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.symbol.filePath !== right.symbol.filePath) {
          return left.symbol.filePath.localeCompare(right.symbol.filePath);
        }
        return left.symbol.line - right.symbol.line;
      });

    const page = filtered.slice(filters.offset, filters.offset + filters.limit);
    return {
      items: page.map((entry) => ({ ...symbolSummary(entry.symbol), score: entry.score })),
      pagination: makePagination(filtered.length, filters.limit, filters.offset),
    };
  }

  getSymbol(workspaceId: string, symbolId: string, contextLines = 3, includeBody = true) {
    this.requireWorkspace(workspaceId);
    const symbol = this.store.getSymbol(symbolId);
    if (!symbol || symbol.workspaceId !== workspaceId) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    const file = this.store.getFile(workspaceId, symbol.filePath);
    if (!file) {
      throw new Error(`Indexed file missing for symbol: ${symbol.filePath}`);
    }

    const startLine = Math.max(1, symbol.line - contextLines);
    const endLine = symbol.endLine + contextLines;
    const lines = file.text.replace(/\r\n/g, "\n").split("\n");
    const snippet = lines.slice(startLine - 1, endLine).join("\n");
    const body = includeBody ? file.text.slice(symbol.startIndex, symbol.endIndex) : "";

    return {
      symbol: symbolSummary(symbol),
      body,
      snippet,
      context_start_line: startLine,
      context_end_line: endLine,
    };
  }

  searchText(filters: SearchTextFilters) {
    this.requireWorkspace(filters.workspaceId);
    const candidateFiles = this.store
      .searchTextCandidateFiles(filters.workspaceId, filters.query)
      .filter((file) => matchesPathGlob(file.filePath, filters.pathGlob));

    const lowerQuery = filters.query.toLowerCase();
    const hits: Array<{
      file_path: string;
      language: SupportedLanguage;
      line: number;
      column: number;
      context: string;
    }> = [];

    for (const file of candidateFiles) {
      const lines = file.text.replace(/\r\n/g, "\n").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const column = lines[index].toLowerCase().indexOf(lowerQuery);
        if (column === -1) {
          continue;
        }
        hits.push({
          file_path: file.filePath,
          language: file.language,
          line: index + 1,
          column: column + 1,
          context: lines[index].trim(),
        });
      }
    }

    const page = hits.slice(filters.offset, filters.offset + filters.limit);
    return {
      items: page,
      pagination: makePagination(hits.length, filters.limit, filters.offset),
    };
  }

  findReferences(workspaceId: string, symbolId: string, includeDeclaration = false, limit = 50, offset = 0) {
    this.requireWorkspace(workspaceId);
    const symbol = this.store.getSymbol(symbolId);
    if (!symbol || symbol.workspaceId !== workspaceId) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    const references = this.store.getReferencesForSymbol(workspaceId, symbolId);
    const items = includeDeclaration
      ? [
          {
            file_path: symbol.filePath,
            line: symbol.line,
            column: 1,
            context: symbol.signature,
            confidence: "high",
            reason: "Declaration site.",
            role: "usage",
            qualifier: null,
            enclosing_symbol_id: symbol.parentSymbolId,
          },
          ...references.map((reference) => ({
            file_path: reference.filePath,
            line: reference.line,
            column: reference.column,
            context: reference.context,
            confidence: reference.confidence,
            reason: reference.reason,
            role: reference.role,
            qualifier: reference.qualifier,
            enclosing_symbol_id: reference.enclosingSymbolId,
          })),
        ]
      : references.map((reference) => ({
          file_path: reference.filePath,
          line: reference.line,
          column: reference.column,
          context: reference.context,
          confidence: reference.confidence,
          reason: reference.reason,
          role: reference.role,
          qualifier: reference.qualifier,
          enclosing_symbol_id: reference.enclosingSymbolId,
        }));

    return {
      symbol: symbolSummary(symbol),
      items: items.slice(offset, offset + limit),
      pagination: makePagination(items.length, limit, offset),
    };
  }

  findCallers(workspaceId: string, symbolId: string, depth = 1, limit = 25) {
    this.requireWorkspace(workspaceId);
    const target = this.store.getSymbol(symbolId);
    if (!target || target.workspaceId !== workspaceId) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    const visited = new Set<string>([symbolId]);
    let frontier = new Set<string>([symbolId]);
    const items: Array<{
      depth: number;
      caller_symbol: SymbolSummary | null;
      callee_symbol: SymbolSummary | null;
      file_path: string;
      line: number;
      column: number;
      context: string;
      confidence: Confidence;
      reason: string;
    }> = [];

    for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
      const nextFrontier = new Set<string>();
      for (const calleeId of frontier) {
        const rows = this.store.getCallsByCallee(workspaceId, calleeId);
        for (const row of rows) {
          const callerSymbol = row.callerSymbolId ? this.store.getSymbol(row.callerSymbolId) : null;
          const calleeSymbol = row.calleeSymbolId ? this.store.getSymbol(row.calleeSymbolId) : null;
          items.push({
            depth: currentDepth,
            caller_symbol: callerSymbol ? symbolSummary(callerSymbol) : null,
            callee_symbol: calleeSymbol ? symbolSummary(calleeSymbol) : null,
            file_path: row.filePath,
            line: row.line,
            column: row.column,
            context: row.context,
            confidence: row.confidence,
            reason: row.reason,
          });
          if (row.callerSymbolId && !visited.has(row.callerSymbolId)) {
            visited.add(row.callerSymbolId);
            nextFrontier.add(row.callerSymbolId);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.size === 0) {
        break;
      }
    }

    return {
      symbol: symbolSummary(target),
      items: items.slice(0, limit),
    };
  }

  findCallees(workspaceId: string, symbolId: string, depth = 1, limit = 25) {
    this.requireWorkspace(workspaceId);
    const origin = this.store.getSymbol(symbolId);
    if (!origin || origin.workspaceId !== workspaceId) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    const visited = new Set<string>([symbolId]);
    let frontier = new Set<string>([symbolId]);
    const items: Array<{
      depth: number;
      caller_symbol: SymbolSummary | null;
      callee_symbol: SymbolSummary | null;
      callee_name: string;
      file_path: string;
      line: number;
      column: number;
      context: string;
      confidence: Confidence;
      reason: string;
    }> = [];

    for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
      const nextFrontier = new Set<string>();
      for (const callerId of frontier) {
        const rows = this.store.getCallsByCaller(workspaceId, callerId);
        for (const row of rows) {
          const callerSymbol = row.callerSymbolId ? this.store.getSymbol(row.callerSymbolId) : null;
          const calleeSymbol = row.calleeSymbolId ? this.store.getSymbol(row.calleeSymbolId) : null;
          items.push({
            depth: currentDepth,
            caller_symbol: callerSymbol ? symbolSummary(callerSymbol) : null,
            callee_symbol: calleeSymbol ? symbolSummary(calleeSymbol) : null,
            callee_name: row.calleeName,
            file_path: row.filePath,
            line: row.line,
            column: row.column,
            context: row.context,
            confidence: row.confidence,
            reason: row.reason,
          });
          if (row.calleeSymbolId && !visited.has(row.calleeSymbolId)) {
            visited.add(row.calleeSymbolId);
            nextFrontier.add(row.calleeSymbolId);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.size === 0) {
        break;
      }
    }

    return {
      symbol: symbolSummary(origin),
      items: items.slice(0, limit),
    };
  }

  languageCounts(workspaceId: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const file of this.store.getFileMeta(workspaceId)) {
      counts[file.language] = (counts[file.language] ?? 0) + 1;
    }
    return counts;
  }

  metaForWorkspace(workspaceId: string, startedAt: number, extra?: Partial<MetaEnvelope>): MetaEnvelope {
    const workspace = this.store.getWorkspace(workspaceId);
    return {
      timing_ms: Number((performance.now() - startedAt).toFixed(1)),
      workspace_id: workspaceId,
      indexed_revision: workspace?.indexedRevision,
      watch_status: workspace?.watchStatus,
      ...extra,
    };
  }

  private async performFullIndex(config: WorkspaceConfig): Promise<void> {
    const startedAt = new Date().toISOString();
    const revision = readGitRevision(config.rootPath);
    this.store.upsertWorkspace(config, startedAt, revision);
    this.store.setWorkspaceWatchState(config.workspaceId, "indexing", null);
    this.store.clearWorkspaceIndex(config.workspaceId);

    try {
      for (const absolutePath of this.collectWorkspaceFiles(config)) {
        this.indexAbsoluteFile(config, absolutePath);
      }
      this.rebuildRelations(config);
      this.store.updateWorkspaceCounts(config.workspaceId);
      this.store.setWorkspaceRevision(config.workspaceId, startedAt, revision);
      this.store.setWorkspaceWatchState(config.workspaceId, this.enableWatch ? "watching" : "indexed", null);
      if (this.enableWatch) {
        this.ensureWatcher(config);
      }
    } catch (error) {
      this.store.setWorkspaceWatchState(
        config.workspaceId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async performIncrementalRefresh(workspace: WorkspaceConfig): Promise<void> {
    this.store.setWorkspaceWatchState(workspace.workspaceId, "indexing", null);
    const dirty = this.detectDirtyWorkspace(workspace);

    try {
      for (const absolutePath of dirty.changedAbsolutePaths) {
        this.indexAbsoluteFile(workspace, absolutePath);
      }
      for (const filePath of dirty.removedFilePaths) {
        this.store.removeFile(workspace.workspaceId, filePath);
      }
      this.rebuildRelations(workspace);
      this.store.updateWorkspaceCounts(workspace.workspaceId);
      this.store.setWorkspaceRevision(workspace.workspaceId, new Date().toISOString(), readGitRevision(workspace.rootPath));
      this.store.setWorkspaceWatchState(workspace.workspaceId, this.enableWatch ? "watching" : "indexed", null);
    } catch (error) {
      this.store.setWorkspaceWatchState(
        workspace.workspaceId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private collectWorkspaceFiles(config: WorkspaceConfig): string[] {
    const ignoreMatcher = ignore();
    if (config.followGitignore) {
      const gitignorePath = path.join(config.rootPath, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        ignoreMatcher.add(fs.readFileSync(gitignorePath, "utf8"));
      }
    }

    return fg
      .sync("**/*", {
        cwd: config.rootPath,
        absolute: true,
        onlyFiles: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: [...DEFAULT_EXCLUDE_GLOBS, ...config.extraExcludeGlobs],
      })
      .filter((absolutePath) => {
        const relativePath = relativeWorkspacePath(config.rootPath, absolutePath);
        if (config.followGitignore && ignoreMatcher.ignores(relativePath)) {
          return false;
        }
        if (!languageFromFilePath(relativePath) || isSecretLikePath(relativePath)) {
          return false;
        }
        const stat = fs.statSync(absolutePath);
        return stat.isFile() && stat.size <= MAX_FILE_BYTES;
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private detectDirtyWorkspace(workspace: WorkspaceConfig): DirtyWorkspaceResult {
    const currentFiles = this.collectWorkspaceFiles(workspace);
    const currentByPath = new Map(
      currentFiles.map((absolutePath) => {
        const stat = fs.statSync(absolutePath);
        return [
          relativeWorkspacePath(workspace.rootPath, absolutePath),
          { absolutePath, size: stat.size, mtimeMs: stat.mtimeMs },
        ];
      }),
    );

    const storedFiles = this.store.getFileMeta(workspace.workspaceId);
    const changedAbsolutePaths: string[] = [];
    const removedFilePaths: string[] = [];

    for (const storedFile of storedFiles) {
      const current = currentByPath.get(storedFile.filePath);
      if (!current) {
        removedFilePaths.push(storedFile.filePath);
        continue;
      }
      if (current.size !== storedFile.size || Math.floor(current.mtimeMs) !== Math.floor(storedFile.mtimeMs)) {
        changedAbsolutePaths.push(current.absolutePath);
      }
      currentByPath.delete(storedFile.filePath);
    }

    for (const remaining of currentByPath.values()) {
      changedAbsolutePaths.push(remaining.absolutePath);
    }

    return { changedAbsolutePaths, removedFilePaths };
  }

  private indexAbsoluteFile(config: WorkspaceConfig, absolutePath: string): void {
    const relativePath = relativeWorkspacePath(config.rootPath, absolutePath);
    const language = languageFromFilePath(relativePath);
    if (!language || isSecretLikePath(relativePath)) {
      return;
    }

    const stats = fs.statSync(absolutePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      return;
    }

    const text = fs.readFileSync(absolutePath, "utf8");
    if (isBinaryContent(text)) {
      return;
    }

    const parsed = parseFile(config.workspaceId, relativePath, text, language);
    const indexedFile: IndexedFile = {
      workspaceId: config.workspaceId,
      filePath: relativePath,
      absolutePath,
      language,
      text,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: hashText(text),
      imports: parsed.imports,
      references: parsed.references,
      calls: parsed.calls,
      parseError: parsed.parseError,
    };

    this.store.saveIndexedFile(indexedFile, parsed.symbols);
  }

  private rebuildRelations(workspace: WorkspaceConfig): void {
    const files = this.store.getFiles(workspace.workspaceId);
    const symbols = this.store.getSymbols(workspace.workspaceId);
    const filesByPath = new Map(files.map((file) => [file.filePath, file] as const));
    const knownFiles = new Set(files.map((file) => file.filePath));
    const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol] as const));
    const symbolsByName = new Map<string, CodeSymbol[]>();
    const symbolsByFileAndName = new Map<string, Map<string, CodeSymbol[]>>();
    const methodsByClassId = new Map<string, Map<string, CodeSymbol[]>>();

    for (const symbol of symbols) {
      const byName = symbolsByName.get(symbol.name) ?? [];
      byName.push(symbol);
      symbolsByName.set(symbol.name, byName);

      const fileMap = symbolsByFileAndName.get(symbol.filePath) ?? new Map<string, CodeSymbol[]>();
      const fileSymbols = fileMap.get(symbol.name) ?? [];
      fileSymbols.push(symbol);
      fileMap.set(symbol.name, fileSymbols);
      symbolsByFileAndName.set(symbol.filePath, fileMap);

      if (symbol.parentSymbolId) {
        const classMap = methodsByClassId.get(symbol.parentSymbolId) ?? new Map<string, CodeSymbol[]>();
        const entries = classMap.get(symbol.name) ?? [];
        entries.push(symbol);
        classMap.set(symbol.name, entries);
        methodsByClassId.set(symbol.parentSymbolId, classMap);
      }
    }

    const references: ResolvedReference[] = [];
    const calls: ResolvedCall[] = [];
    const referenceDedup = new Set<string>();
    const callDedup = new Set<string>();

    for (const file of files) {
      const bindings = this.resolveBindings(workspace, file, knownFiles, filesByPath, symbolsByFileAndName);
      for (const binding of bindings.values()) {
        if (!binding.targetSymbolId) {
          continue;
        }
        const key = `${file.filePath}:${binding.binding.line}:${binding.binding.column}:${binding.targetSymbolId}:import`;
        if (referenceDedup.has(key)) {
          continue;
        }
        referenceDedup.add(key);
        references.push({
          workspaceId: workspace.workspaceId,
          filePath: file.filePath,
          targetSymbolId: binding.targetSymbolId,
          referencedName: binding.binding.importedName,
          qualifier: null,
          enclosingSymbolId: null,
          line: binding.binding.line,
          column: binding.binding.column,
          context: binding.binding.context,
          confidence: binding.confidence,
          reason: binding.reason,
          role: "import",
        });
      }

      for (const reference of file.references) {
        const resolved = this.resolveReference(
          workspace.workspaceId,
          file.filePath,
          reference,
          bindings,
          symbolsById,
          symbolsByName,
          symbolsByFileAndName,
          methodsByClassId,
        );
        if (!resolved.targetSymbolId) {
          continue;
        }
        const key = `${resolved.filePath}:${resolved.line}:${resolved.column}:${resolved.targetSymbolId}:${resolved.role}`;
        if (referenceDedup.has(key)) {
          continue;
        }
        referenceDedup.add(key);
        references.push(resolved);
      }

      for (const call of file.calls) {
        const resolved = this.resolveCall(
          workspace.workspaceId,
          file.filePath,
          call,
          bindings,
          symbolsById,
          symbolsByName,
          symbolsByFileAndName,
          methodsByClassId,
        );
        const key = `${resolved.filePath}:${resolved.line}:${resolved.column}:${resolved.callerSymbolId}:${resolved.calleeSymbolId ?? resolved.calleeName}`;
        if (callDedup.has(key)) {
          continue;
        }
        callDedup.add(key);
        calls.push(resolved);
      }
    }

    this.store.replaceResolvedRelations(workspace.workspaceId, references, calls);
  }

  private resolveBindings(
    workspace: WorkspaceConfig,
    file: IndexedFile,
    knownFiles: Set<string>,
    filesByPath: Map<string, IndexedFile>,
    symbolsByFileAndName: Map<string, Map<string, CodeSymbol[]>>,
  ): Map<string, CandidateBinding> {
    const bindings = new Map<string, CandidateBinding>();

    for (const binding of file.imports) {
      const targetFilePath =
        file.language === "python"
          ? resolvePythonModule(file.filePath, binding.moduleSpecifier, knownFiles)
          : resolveJsImport(workspace.rootPath, file.filePath, binding.moduleSpecifier, knownFiles);

      let targetSymbolId: string | null = null;
      let confidence: Confidence = "low";
      let reason = targetFilePath ? "Resolved import target file." : "Could not resolve import target file.";

      if (targetFilePath) {
        const targetSymbols = symbolsByFileAndName.get(targetFilePath);
        if (binding.kind !== "namespace" && targetSymbols) {
          const matches =
            binding.importedName === "default"
              ? Array.from(targetSymbols.values())
                  .flat()
                  .filter((symbol) => ["function", "class"].includes(symbol.kind))
              : targetSymbols.get(binding.importedName) ?? [];
          if (matches.length === 1) {
            targetSymbolId = matches[0].id;
            confidence = binding.importedName === "default" ? "medium" : "high";
            reason =
              binding.importedName === "default"
                ? "Resolved default import to the file's primary exported symbol."
                : "Resolved named import to a unique symbol in the target file.";
          } else if (matches.length > 1) {
            targetSymbolId = matches[0].id;
            confidence = "low";
            reason = "Multiple target symbols matched this import; using the first indexed symbol.";
          }
        }
      }

      bindings.set(binding.localName, {
        binding,
        targetFilePath,
        targetSymbolId,
        confidence,
        reason,
      });
    }

    return bindings;
  }

  private resolveReference(
    workspaceId: string,
    filePath: string,
    reference: RawReference,
    bindings: Map<string, CandidateBinding>,
    symbolsById: Map<string, CodeSymbol>,
    symbolsByName: Map<string, CodeSymbol[]>,
    symbolsByFileAndName: Map<string, Map<string, CodeSymbol[]>>,
    methodsByClassId: Map<string, Map<string, CodeSymbol[]>>,
  ): ResolvedReference {
    let resolvedSymbol: CodeSymbol | null = null;
    let confidence: Confidence = "low";
    let reason = "No resolution heuristic matched.";

    if ((reference.qualifier === "this" || reference.qualifier === "self" || reference.qualifier === "cls") && reference.enclosingSymbolId) {
      const enclosing = symbolsById.get(reference.enclosingSymbolId);
      if (enclosing?.parentSymbolId) {
        const classMethods = methodsByClassId.get(enclosing.parentSymbolId)?.get(reference.name) ?? [];
        if (classMethods.length === 1) {
          resolvedSymbol = classMethods[0];
          confidence = "high";
          reason = "Resolved through current class method lookup.";
        }
      }
    }

    if (!resolvedSymbol && reference.qualifier && bindings.has(reference.qualifier)) {
      const binding = bindings.get(reference.qualifier)!;
      if (binding.binding.kind === "namespace" && binding.targetFilePath) {
        const namespaceSymbols = symbolsByFileAndName.get(binding.targetFilePath)?.get(reference.name) ?? [];
        if (namespaceSymbols.length === 1) {
          resolvedSymbol = namespaceSymbols[0];
          confidence = "high";
          reason = "Resolved through namespace import and member access.";
        }
      }
    }

    if (!resolvedSymbol && bindings.has(reference.name)) {
      const binding = bindings.get(reference.name)!;
      if (binding.targetSymbolId) {
        resolvedSymbol = symbolsById.get(binding.targetSymbolId) ?? null;
        confidence = binding.confidence;
        reason = binding.reason;
      }
    }

    if (!resolvedSymbol) {
      const localMatches = symbolsByFileAndName.get(filePath)?.get(reference.name) ?? [];
      if (localMatches.length === 1) {
        resolvedSymbol = localMatches[0];
        confidence = "high";
        reason = "Resolved to a unique symbol in the same file.";
      }
    }

    if (!resolvedSymbol) {
      const workspaceMatches = symbolsByName.get(reference.name) ?? [];
      if (workspaceMatches.length === 1) {
        resolvedSymbol = workspaceMatches[0];
        confidence = "medium";
        reason = "Resolved to a unique symbol name across the workspace.";
      }
    }

    return {
      workspaceId,
      filePath,
      targetSymbolId: resolvedSymbol?.id ?? null,
      referencedName: reference.name,
      qualifier: reference.qualifier,
      enclosingSymbolId: reference.enclosingSymbolId,
      line: reference.line,
      column: reference.column,
      context: reference.context,
      confidence,
      reason,
      role: reference.role,
    };
  }

  private resolveCall(
    workspaceId: string,
    filePath: string,
    call: RawCall,
    bindings: Map<string, CandidateBinding>,
    symbolsById: Map<string, CodeSymbol>,
    symbolsByName: Map<string, CodeSymbol[]>,
    symbolsByFileAndName: Map<string, Map<string, CodeSymbol[]>>,
    methodsByClassId: Map<string, Map<string, CodeSymbol[]>>,
  ): ResolvedCall {
    const resolved = this.resolveReference(
      workspaceId,
      filePath,
      {
        name: call.calleeName,
        qualifier: call.qualifier,
        role: "call",
        line: call.line,
        column: call.column,
        context: call.context,
        enclosingSymbolId: call.callerSymbolId,
      },
      bindings,
      symbolsById,
      symbolsByName,
      symbolsByFileAndName,
      methodsByClassId,
    );

    return {
      workspaceId: resolved.workspaceId,
      filePath,
      callerSymbolId: call.callerSymbolId,
      calleeSymbolId: resolved.targetSymbolId,
      calleeName: call.calleeName,
      qualifier: call.qualifier,
      line: call.line,
      column: call.column,
      context: call.context,
      confidence: resolved.confidence,
      reason: resolved.reason,
    };
  }

  private ensureWatcher(workspace: WorkspaceConfig): void {
    if (this.watchStates.has(workspace.workspaceId)) {
      return;
    }

    const watcher = chokidar.watch(workspace.rootPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
      ignored: (watchedPath) => {
        const relativePath = relativeWorkspacePath(workspace.rootPath, watchedPath);
        if (!relativePath || relativePath.startsWith("..")) {
          return false;
        }
        if (DEFAULT_EXCLUDE_GLOBS.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) {
          return true;
        }
        if (workspace.extraExcludeGlobs.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) {
          return true;
        }
        return isSecretLikePath(relativePath);
      },
    });

    const state: WorkspaceWatchState = {
      watcher,
      queuedChanges: new Map(),
      fullRefreshQueued: false,
      timer: null,
    };

    const schedule = () => {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.flushWatchQueue(workspace.workspaceId);
      }, 300);
    };

    watcher.on("add", (absolutePath) => {
      state.queuedChanges.set(absolutePath, "change");
      schedule();
    });
    watcher.on("change", (absolutePath) => {
      state.queuedChanges.set(absolutePath, "change");
      schedule();
    });
    watcher.on("unlink", (absolutePath) => {
      state.queuedChanges.set(absolutePath, "unlink");
      schedule();
    });
    watcher.on("error", (error) => {
      state.fullRefreshQueued = true;
      this.store.setWorkspaceWatchState(
        workspace.workspaceId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      schedule();
    });

    this.watchStates.set(workspace.workspaceId, state);
  }

  private async flushWatchQueue(workspaceId: string): Promise<void> {
    const workspace = this.requireWorkspace(workspaceId);
    const state = this.watchStates.get(workspaceId);
    if (!state) {
      return;
    }

    if (state.fullRefreshQueued) {
      state.fullRefreshQueued = false;
      state.queuedChanges.clear();
      await this.performFullIndex(workspace);
      return;
    }

    if (state.queuedChanges.size === 0) {
      return;
    }

    const queued = Array.from(state.queuedChanges.entries());
    state.queuedChanges.clear();
    this.store.setWorkspaceWatchState(workspaceId, "indexing", null);

    try {
      for (const [absolutePath, operation] of queued) {
        const relativePath = relativeWorkspacePath(workspace.rootPath, absolutePath);
        if (relativePath === ".git/HEAD") {
          await this.performFullIndex(workspace);
          return;
        }
        if (operation === "unlink") {
          this.store.removeFile(workspaceId, relativePath);
          continue;
        }
        if (!fs.existsSync(absolutePath)) {
          continue;
        }
        this.indexAbsoluteFile(workspace, absolutePath);
      }
      this.rebuildRelations(workspace);
      this.store.updateWorkspaceCounts(workspaceId);
      this.store.setWorkspaceRevision(workspaceId, new Date().toISOString(), readGitRevision(workspace.rootPath));
      this.store.setWorkspaceWatchState(workspaceId, "watching", null);
    } catch (error) {
      this.store.setWorkspaceWatchState(
        workspaceId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace;
  }
}
