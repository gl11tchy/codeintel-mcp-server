import fs from "node:fs";

import chokidar, { type FSWatcher } from "chokidar";
import fg from "fast-glob";
import ignore from "ignore";
import { minimatch } from "minimatch";

import type { Store } from "../db/store.js";
import { parseFile } from "../parser/extract.js";
import type { IndexedFile, WorkspaceConfig, WorkspaceRecord } from "../types.js";
import type { Resolver } from "./resolver.js";
import { readTsconfigPaths } from "./tsconfig.js";
import {
  DEFAULT_EXCLUDE_GLOBS,
  MAX_FILE_BYTES,
  hashText,
  isBinaryContent,
  isSecretLikePath,
  languageFromFilePath,
  readGitRevision,
  relativeWorkspacePath,
} from "./utils.js";

interface WorkspaceWatchState {
  watcher: FSWatcher;
  queuedChanges: Map<string, "change" | "unlink">;
  fullRefreshQueued: boolean;
  timer: NodeJS.Timeout | null;
}

interface DirtyWorkspaceResult {
  changedAbsolutePaths: string[];
  removedFilePaths: string[];
}

export class Indexer {
  private readonly watchStates = new Map<string, WorkspaceWatchState>();

  constructor(
    readonly store: Store,
    readonly enableWatch: boolean,
    readonly resolver: Resolver,
    private readonly requireWorkspace: (workspaceId: string) => WorkspaceRecord,
  ) {}

  async close(): Promise<void> {
    for (const watchState of this.watchStates.values()) {
      if (watchState.timer) {
        clearTimeout(watchState.timer);
      }
      await watchState.watcher.close();
    }
    this.watchStates.clear();
  }

  async performFullIndex(config: WorkspaceConfig): Promise<void> {
    const startedAt = new Date().toISOString();
    const revision = readGitRevision(config.rootPath);
    this.store.upsertWorkspace(config, startedAt, revision);
    this.store.setWorkspaceWatchState(config.workspaceId, "indexing", null);
    this.store.clearWorkspaceIndex(config.workspaceId);

    try {
      for (const absolutePath of this.collectWorkspaceFiles(config)) {
        this.indexAbsoluteFile(config, absolutePath);
      }
      const tsconfigPaths = readTsconfigPaths(config.rootPath);
      this.resolver.rebuildRelations(config, tsconfigPaths);
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

  async performIncrementalRefresh(workspace: WorkspaceConfig): Promise<void> {
    this.store.setWorkspaceWatchState(workspace.workspaceId, "indexing", null);
    const dirty = this.detectDirtyWorkspace(workspace);

    try {
      const changedRelPaths = dirty.changedAbsolutePaths.map(
        (absPath) => relativeWorkspacePath(workspace.rootPath, absPath),
      );
      for (const absolutePath of dirty.changedAbsolutePaths) {
        const relativePath = relativeWorkspacePath(workspace.rootPath, absolutePath);
        const wasPreviouslyIndexed = this.store.getFile(workspace.workspaceId, relativePath) !== null;
        const wasIndexed = this.indexAbsoluteFile(workspace, absolutePath);
        if (!wasIndexed && wasPreviouslyIndexed) {
          this.store.removeFile(workspace.workspaceId, relativePath);
        }
      }
      for (const filePath of dirty.removedFilePaths) {
        this.store.removeFile(workspace.workspaceId, filePath);
      }
      const allChangedPaths = [...changedRelPaths, ...dirty.removedFilePaths];
      const tsconfigPaths = readTsconfigPaths(workspace.rootPath);
      this.resolver.rebuildRelationsForFiles(workspace, allChangedPaths, tsconfigPaths);
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

  collectWorkspaceFiles(config: WorkspaceConfig): string[] {
    const ignoreMatcher = ignore();
    if (config.followGitignore) {
      const gitignorePath = `${config.rootPath}/.gitignore`;
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

  detectDirtyWorkspace(workspace: WorkspaceConfig): DirtyWorkspaceResult {
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

  /**
   * Index a single file. Returns `true` if the file was indexed, `false` if it
   * was skipped due to eligibility checks (non-indexable language, secret path,
   * oversized, binary content).
   */
  indexAbsoluteFile(config: WorkspaceConfig, absolutePath: string): boolean {
    const relativePath = relativeWorkspacePath(config.rootPath, absolutePath);
    const language = languageFromFilePath(relativePath);
    if (!language || isSecretLikePath(relativePath)) {
      return false;
    }

    const stats = fs.statSync(absolutePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      return false;
    }

    const text = fs.readFileSync(absolutePath, "utf8");
    if (isBinaryContent(text)) {
      return false;
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
    return true;
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

    if (state.queuedChanges.size === 0 && !state.fullRefreshQueued) {
      return;
    }

    const queued = Array.from(state.queuedChanges.entries());
    state.queuedChanges.clear();
    const wasFullRefreshQueued = state.fullRefreshQueued;
    state.fullRefreshQueued = false;

    try {
      if (wasFullRefreshQueued) {
        await this.performFullIndex(workspace);
        return;
      }

      this.store.setWorkspaceWatchState(workspaceId, "indexing", null);

      const changedPaths: string[] = [];
      for (const [absolutePath, operation] of queued) {
        const relativePath = relativeWorkspacePath(workspace.rootPath, absolutePath);
        if (relativePath === ".git/HEAD" || relativePath === "tsconfig.json" || relativePath === "jsconfig.json") {
          await this.performFullIndex(workspace);
          return;
        }
        if (operation === "unlink") {
          changedPaths.push(relativePath);
          this.store.removeFile(workspaceId, relativePath);
          continue;
        }
        if (!fs.existsSync(absolutePath)) {
          continue;
        }
        changedPaths.push(relativePath);
        const wasPreviouslyIndexed = this.store.getFile(workspaceId, relativePath) !== null;
        const wasIndexed = this.indexAbsoluteFile(workspace, absolutePath);
        // If indexAbsoluteFile skipped the file (non-indexable language, secret,
        // oversized, binary) but it was previously indexed, remove the stale entry.
        if (!wasIndexed && wasPreviouslyIndexed) {
          this.store.removeFile(workspaceId, relativePath);
        }
      }
      const tsconfigPaths = readTsconfigPaths(workspace.rootPath);
      this.resolver.rebuildRelationsForFiles(workspace, changedPaths, tsconfigPaths);
      this.store.updateWorkspaceCounts(workspaceId);
      this.store.setWorkspaceRevision(workspaceId, new Date().toISOString(), readGitRevision(workspace.rootPath));
      this.store.setWorkspaceWatchState(workspaceId, "watching", null);
    } catch (error) {
      // Restore queued changes so they can be retried on the next flush
      for (const [filePath, op] of queued) {
        if (!state.queuedChanges.has(filePath)) {
          state.queuedChanges.set(filePath, op);
        }
      }
      if (wasFullRefreshQueued) {
        state.fullRefreshQueued = true;
      }
      this.store.setWorkspaceWatchState(
        workspaceId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
