import fs from "node:fs";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";
import fg from "fast-glob";
import ignore from "ignore";
import { minimatch } from "minimatch";

import type { Store } from "../db/store.js";
import { parseFile } from "../parser/extract.js";
import type { IndexedFile, WorkspaceConfig, WorkspaceRecord } from "../types.js";
import type { Resolver } from "./resolver.js";
import { readTsconfigInfo, readTsconfigPaths, type TsconfigPaths } from "./tsconfig.js";
import {
  DEFAULT_EXCLUDE_GLOBS,
  getGitWatchPaths,
  MAX_FILE_BYTES,
  hashText,
  isBinaryContent,
  isSecretLikePath,
  languageFromFilePath,
  readGitRevision,
  relativeWorkspacePath,
  toPosixPath,
} from "./utils.js";

const CONTROL_FILE_PATHS = ["tsconfig.json", "jsconfig.json"] as const;

interface WorkspaceWatchState {
  watcher: FSWatcher;
  queuedChanges: Map<string, "change" | "unlink">;
  fullRefreshQueued: boolean;
  configControlPaths: string[];
  gitControlPaths: string[];
  externalWatchPaths: string[];
  ready: Promise<void>;
  startupState: "pending" | "ready" | "failed";
  timer: NodeJS.Timeout | null;
}

interface DirtyWorkspaceResult {
  changedAbsolutePaths: string[];
  removedFilePaths: string[];
  changedControlFiles: string[];
  currentGitRevision: string;
  requiresFullRebuild: boolean;
}

interface WorkspaceChangeSet {
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

  async waitForWatcherReady(workspaceId: string): Promise<void> {
    await this.watchStates.get(workspaceId)?.ready;
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
      this.store.replaceWorkspaceControlFileStates(config.workspaceId, this.readControlFileStates(config.rootPath));
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

  async performIncrementalRefresh(workspace: WorkspaceRecord): Promise<void> {
    this.store.setWorkspaceWatchState(workspace.workspaceId, "indexing", null);
    const dirty = this.detectDirtyWorkspace(workspace);

    try {
      if (dirty.requiresFullRebuild) {
        await this.performFullIndex(workspace);
        return;
      }
      this.applyWorkspaceFileChanges(workspace, {
        changedAbsolutePaths: dirty.changedAbsolutePaths,
        removedFilePaths: dirty.removedFilePaths,
      });
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

  detectDirtyWorkspace(workspace: WorkspaceRecord): DirtyWorkspaceResult {
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

    const changedControlFiles = this.detectChangedControlFiles(workspace);
    const currentGitRevision = readGitRevision(workspace.rootPath);
    if (currentGitRevision !== workspace.indexedRevision) {
      changedControlFiles.push(".git/HEAD");
    }

    return {
      changedAbsolutePaths,
      removedFilePaths,
      changedControlFiles,
      currentGitRevision,
      requiresFullRebuild: changedControlFiles.length > 0,
    };
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

  applyWorkspaceFileChanges(
    workspace: WorkspaceConfig,
    changes: WorkspaceChangeSet,
    options?: { updateRevision?: boolean },
  ): void {
    const changedFilePaths = Array.from(
      new Set(changes.changedAbsolutePaths.map((absolutePath) => relativeWorkspacePath(workspace.rootPath, absolutePath))),
    );
    const removedFilePaths = Array.from(new Set(changes.removedFilePaths));
    const trackedFilePaths = Array.from(new Set([...changedFilePaths, ...removedFilePaths]));

    const previousSymbolsByFile = new Map(
      trackedFilePaths.map((filePath) => [filePath, this.store.getFileSymbols(workspace.workspaceId, filePath)]),
    );

    for (const absolutePath of changes.changedAbsolutePaths) {
      const relativePath = relativeWorkspacePath(workspace.rootPath, absolutePath);
      const wasPreviouslyIndexed = this.store.getFile(workspace.workspaceId, relativePath) !== null;

      if (!fs.existsSync(absolutePath)) {
        if (wasPreviouslyIndexed) {
          this.store.removeFile(workspace.workspaceId, relativePath);
        }
        continue;
      }

      const wasIndexed = this.indexAbsoluteFile(workspace, absolutePath);
      if (!wasIndexed && wasPreviouslyIndexed) {
        this.store.removeFile(workspace.workspaceId, relativePath);
      }
    }

    for (const filePath of removedFilePaths) {
      this.store.removeFile(workspace.workspaceId, filePath);
    }

    const nextSymbolsByFile = new Map(
      trackedFilePaths.map((filePath) => [filePath, this.store.getFileSymbols(workspace.workspaceId, filePath)]),
    );

    const tsconfigPaths = readTsconfigPaths(workspace.rootPath);
    const changedSymbolNames = this.collectChangedSymbolNames(previousSymbolsByFile, nextSymbolsByFile);
    const directImportDependents = this.findDirectImportDependents(workspace, trackedFilePaths, tsconfigPaths);
    const nameDependents = this.store.getFilesMentioningNames(workspace.workspaceId, changedSymbolNames);
    const affectedPaths = Array.from(
      new Set([...trackedFilePaths, ...directImportDependents, ...nameDependents]),
    ).sort((left, right) => left.localeCompare(right));

    this.resolver.rebuildRelationsForFiles(workspace, affectedPaths, tsconfigPaths);
    this.store.updateWorkspaceCounts(workspace.workspaceId);

    if (options?.updateRevision ?? true) {
      this.store.setWorkspaceRevision(
        workspace.workspaceId,
        new Date().toISOString(),
        readGitRevision(workspace.rootPath),
      );
    }
  }

  private ensureWatcher(workspace: WorkspaceConfig): void {
    const existingState = this.watchStates.get(workspace.workspaceId);
    if (existingState) {
      const nextWatchConfig = this.getWatchConfig(workspace.rootPath);
      const controlPathsChanged = !this.haveSamePaths(
        existingState.configControlPaths,
        nextWatchConfig.configControlPaths,
      ) || !this.haveSamePaths(
        existingState.gitControlPaths,
        nextWatchConfig.gitControlPaths,
      );

      if (existingState.startupState === "failed" || controlPathsChanged) {
        this.disposeWatcherState(workspace.workspaceId, existingState);
      } else {
        existingState.configControlPaths = nextWatchConfig.configControlPaths;
        existingState.gitControlPaths = nextWatchConfig.gitControlPaths;

        const pathsToAdd = nextWatchConfig.externalWatchPaths.filter(
          (watchedPath) => !existingState.externalWatchPaths.includes(watchedPath),
        );
        const pathsToRemove = existingState.externalWatchPaths.filter(
          (watchedPath) => !nextWatchConfig.externalWatchPaths.includes(watchedPath),
        );

        if (pathsToAdd.length > 0) {
          existingState.watcher.add(pathsToAdd);
        }
        if (pathsToRemove.length > 0) {
          void existingState.watcher.unwatch(pathsToRemove);
        }
        existingState.externalWatchPaths = nextWatchConfig.externalWatchPaths;
        return;
      }
    }

    const watchConfig = this.getWatchConfig(workspace.rootPath);
    let state: WorkspaceWatchState | undefined;
    const watcher = chokidar.watch([workspace.rootPath, ...watchConfig.externalWatchPaths], {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
      ignored: (watchedPath) => {
        const currentState = this.watchStates.get(workspace.workspaceId) ?? state;
        const gitControlPaths = currentState?.gitControlPaths ?? watchConfig.gitControlPaths;
        const configControlPaths = currentState?.configControlPaths ?? watchConfig.configControlPaths;
        const absolutePath = path.resolve(watchedPath);
        if (
          this.isGitControlPath(absolutePath, gitControlPaths)
          || this.isConfigControlPath(absolutePath, configControlPaths)
        ) {
          return false;
        }

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

    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const resolveWatcherReady = () => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      if (state) {
        state.startupState = "ready";
      }
      resolveReady();
    };
    const rejectWatcherReady = (error: unknown) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      if (state) {
        state.startupState = "failed";
      }
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    };
    watcher.once("ready", resolveWatcherReady);
    void ready.catch(() => {});

    state = {
      watcher,
      queuedChanges: new Map(),
      fullRefreshQueued: false,
      configControlPaths: watchConfig.configControlPaths,
      gitControlPaths: watchConfig.gitControlPaths,
      externalWatchPaths: watchConfig.externalWatchPaths,
      ready,
      startupState: "pending",
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

    const queueChange = (absolutePath: string, operation: "change" | "unlink") => {
      const resolvedPath = path.resolve(absolutePath);
      if (this.isGitControlPath(resolvedPath, state.gitControlPaths)) {
        state.fullRefreshQueued = true;
        schedule();
        return;
      }
      if (this.isConfigControlPath(resolvedPath, state.configControlPaths)) {
        state.fullRefreshQueued = true;
        schedule();
        return;
      }

      const relativePath = relativeWorkspacePath(workspace.rootPath, resolvedPath);
      if (!relativePath || relativePath.startsWith("..")) {
        return;
      }

      state.queuedChanges.set(resolvedPath, operation);
      schedule();
    };

    watcher.on("add", (absolutePath) => {
      queueChange(absolutePath, "change");
    });
    watcher.on("change", (absolutePath) => {
      queueChange(absolutePath, "change");
    });
    watcher.on("unlink", (absolutePath) => {
      queueChange(absolutePath, "unlink");
    });
    watcher.on("error", (error) => {
      rejectWatcherReady(error);
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

  private disposeWatcherState(workspaceId: string, state: WorkspaceWatchState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.watchStates.delete(workspaceId);
    void state.watcher.close();
  }

  private haveSamePaths(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
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

      const changedAbsolutePaths: string[] = [];
      const removedFilePaths: string[] = [];
      for (const [absolutePath, operation] of queued) {
        const relativePath = relativeWorkspacePath(workspace.rootPath, absolutePath);
        if (
          this.isGitControlPath(path.resolve(absolutePath), state.gitControlPaths)
          || CONTROL_FILE_PATHS.includes(relativePath as (typeof CONTROL_FILE_PATHS)[number])
        ) {
          await this.performFullIndex(workspace);
          return;
        }
        if (operation === "unlink") {
          removedFilePaths.push(relativePath);
          continue;
        }
        changedAbsolutePaths.push(absolutePath);
      }
      this.applyWorkspaceFileChanges(workspace, { changedAbsolutePaths, removedFilePaths });
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

  private detectChangedControlFiles(workspace: WorkspaceConfig): string[] {
    const previousStates = new Map(this.store.getWorkspaceControlFileStates(workspace.workspaceId).map((state) => [state.filePath, state] as const));
    const currentStates = new Map(this.readControlFileStates(workspace.rootPath).map((state) => [state.filePath, state] as const));
    const controlFilePaths = Array.from(new Set([...previousStates.keys(), ...currentStates.keys()]));

    return controlFilePaths
      .filter((filePath) => {
        const previous = previousStates.get(filePath);
        const current = currentStates.get(filePath);
        return (
          previous?.isPresent !== current?.isPresent
          || previous?.contentHash !== current?.contentHash
        );
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private readControlFileStates(rootPath: string): Array<{ filePath: string; isPresent: boolean; contentHash: string | null }> {
    const rootControlPaths = CONTROL_FILE_PATHS.map((filePath) => path.join(rootPath, filePath));
    const tsconfigInfo = readTsconfigInfo(rootPath);
    const controlPaths = Array.from(new Set([...rootControlPaths, ...tsconfigInfo.configFiles]));

    return controlPaths.map((absolutePath) => {
      const filePath = this.controlFilePath(rootPath, absolutePath);
      if (!fs.existsSync(absolutePath)) {
        return {
          filePath,
          isPresent: false,
          contentHash: null,
        };
      }

      return {
        filePath,
        isPresent: true,
        contentHash: hashText(fs.readFileSync(absolutePath, "utf8")),
      };
    });
  }

  private findDirectImportDependents(
    workspace: WorkspaceConfig,
    targetFilePaths: string[],
    tsconfigPaths?: TsconfigPaths | null,
  ): string[] {
    if (targetFilePaths.length === 0) {
      return [];
    }

    const files = this.store.getFiles(workspace.workspaceId);
    const knownFiles = new Set(files.map((file) => file.filePath));
    const targets = new Set(targetFilePaths);
    const resolutionFileSet = new Set([...knownFiles, ...targetFilePaths]);
    const dependents = new Set<string>();

    for (const file of files) {
      if (targets.has(file.filePath)) {
        continue;
      }

      for (const binding of file.imports) {
        const resolvedTarget = this.resolver.resolveImportTargetFilePath(
          workspace,
          file,
          binding,
          resolutionFileSet,
          tsconfigPaths,
        );
        if (resolvedTarget && targets.has(resolvedTarget)) {
          dependents.add(file.filePath);
          break;
        }
      }
    }

    return Array.from(dependents).sort((left, right) => left.localeCompare(right));
  }

  private isGitControlPath(absolutePath: string, gitControlPaths: string[]): boolean {
    return gitControlPaths.some(
      (controlPath) => absolutePath === controlPath || absolutePath.startsWith(`${controlPath}${path.sep}`),
    );
  }

  private isConfigControlPath(absolutePath: string, configControlPaths: string[]): boolean {
    return configControlPaths.some(
      (controlPath) => absolutePath === controlPath || controlPath.startsWith(`${absolutePath}${path.sep}`),
    );
  }

  private controlFilePath(rootPath: string, absolutePath: string): string {
    const relativePath = relativeWorkspacePath(rootPath, absolutePath);
    return !relativePath || relativePath.startsWith("..") ? toPosixPath(absolutePath) : relativePath;
  }

  private getWatchConfig(rootPath: string): {
    configControlPaths: string[];
    gitControlPaths: string[];
    externalWatchPaths: string[];
  } {
    const gitControlPaths = getGitWatchPaths(rootPath).map((watchedPath) => path.resolve(watchedPath));
    const configControlPaths = readTsconfigInfo(rootPath).configFiles.map((watchedPath) => path.resolve(watchedPath));
    const externalConfigWatchPaths = configControlPaths
      .filter((controlPath) => relativeWorkspacePath(rootPath, controlPath).startsWith(".."))
      .map((controlPath) => (fs.existsSync(controlPath) ? controlPath : path.dirname(controlPath)));

    return {
      configControlPaths,
      gitControlPaths,
      externalWatchPaths: Array.from(new Set([...gitControlPaths, ...externalConfigWatchPaths])),
    };
  }

  private collectChangedSymbolNames(
    previousSymbolsByFile: Map<string, Array<{ name: string }>>,
    nextSymbolsByFile: Map<string, Array<{ name: string }>>,
  ): string[] {
    const names = new Set<string>();
    for (const symbols of previousSymbolsByFile.values()) {
      for (const symbol of symbols) {
        names.add(symbol.name);
      }
    }
    for (const symbols of nextSymbolsByFile.values()) {
      for (const symbol of symbols) {
        names.add(symbol.name);
      }
    }
    return Array.from(names).sort((left, right) => left.localeCompare(right));
  }
}
