import fs from "node:fs";
import path from "node:path";

import { minimatch } from "minimatch";

import { Store } from "../db/store.js";
import type {
  CodeSymbol,
  Confidence,
  FileTreeNode,
  MetaEnvelope,
  OutlineNode,
  PaginationEnvelope,
  SearchSymbolFilters,
  SearchTextFilters,
  SupportedLanguage,
  SymbolSummary,
  WorkspaceConfig,
  WorkspaceRecord,
  WorkspaceSummary,
} from "../types.js";
import { Indexer } from "./indexer.js";
import { Refactor, type RenameResult, type MoveResult } from "./refactor.js";
import { Resolver } from "./resolver.js";
import {
  ensureDir,
  findGitRoot,
  getPaths,
  readGitRevision,
  relativeWorkspacePath,
  stableWorkspaceId,
} from "./utils.js";

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
  private readonly indexer: Indexer;
  private readonly resolver: Resolver;
  private readonly refactor: Refactor;
  private _closed = false;

  constructor(options?: { dbPath?: string; enableWatch?: boolean }) {
    const paths = getPaths();
    ensureDir(paths.cache);
    ensureDir(paths.log);
    this.dbPath = options?.dbPath ?? path.join(paths.cache, "codeintel.sqlite");
    this.enableWatch = options?.enableWatch ?? true;
    this.store = new Store(this.dbPath);
    this.resolver = new Resolver(this.store);
    this.refactor = new Refactor(this.store);
    this.indexer = new Indexer(
      this.store,
      this.enableWatch,
      this.resolver,
      (workspaceId) => this.requireWorkspace(workspaceId),
    );
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    await this.indexer.close();
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

    await this.indexer.performFullIndex(config);
    const record = this.requireWorkspace(workspaceId);
    return {
      workspace: workspaceSummary(record),
      languages: this.languageCounts(workspaceId),
    };
  }

  async refreshWorkspace(workspaceId: string, full = false) {
    const workspace = this.requireWorkspace(workspaceId);
    if (full) {
      await this.indexer.performFullIndex(workspace);
    } else {
      await this.indexer.performIncrementalRefresh(workspace);
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
    const dirty = this.indexer.detectDirtyWorkspace(workspace);
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

  renameSymbol(workspaceId: string, symbolId: string, newName: string, dryRun = true): RenameResult {
    const workspace = this.requireWorkspace(workspaceId);
    const result = this.refactor.renameSymbol(workspaceId, symbolId, newName, dryRun, workspace.rootPath);

    if (result.applied) {
      const affectedPaths = [...new Set(result.edits.map((e) => e.filePath))];
      for (const filePath of affectedPaths) {
        const absolutePath = path.join(workspace.rootPath, filePath);
        if (fs.existsSync(absolutePath)) {
          this.indexer.indexAbsoluteFile(workspace, absolutePath);
        }
      }
      this.resolver.rebuildRelationsForFiles(workspace, affectedPaths);
      this.store.updateWorkspaceCounts(workspaceId);
    }

    return result;
  }

  moveSymbol(workspaceId: string, symbolId: string, targetFilePath: string, dryRun = true): MoveResult {
    const workspace = this.requireWorkspace(workspaceId);
    const result = this.refactor.moveSymbol(workspaceId, symbolId, targetFilePath, dryRun, workspace.rootPath);

    if (result.applied) {
      const affectedPaths = [...new Set(result.edits.map((e) => e.filePath))];
      for (const filePath of affectedPaths) {
        const absolutePath = path.join(workspace.rootPath, filePath);
        if (fs.existsSync(absolutePath)) {
          this.indexer.indexAbsoluteFile(workspace, absolutePath);
        }
      }
      this.resolver.rebuildRelationsForFiles(workspace, affectedPaths);
      this.store.updateWorkspaceCounts(workspaceId);
    }

    return result;
  }

  private requireWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace;
  }
}
