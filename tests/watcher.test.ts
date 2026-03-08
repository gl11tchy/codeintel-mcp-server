import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  watchInvocations: 0,
  behaviors: [] as Array<"error" | "pending" | "ready">,
  ignored: undefined as ((watchedPath: string) => boolean) | undefined,
}));

vi.mock("chokidar", async () => {
  const { EventEmitter } = await import("node:events");

  return {
    default: {
      watch: (_paths: string | string[], options?: { ignored?: (watchedPath: string) => boolean }) => {
        mockState.watchInvocations += 1;
        const invocation = mockState.watchInvocations;
        mockState.ignored = options?.ignored;
        const watcher = new EventEmitter() as EventEmitter & {
          add: (_paths: string | string[]) => void;
          close: () => Promise<void>;
          unwatch: (_paths: string | string[]) => Promise<void>;
        };
        watcher.add = () => {};
        watcher.close = async () => {};
        watcher.unwatch = async () => {};
        queueMicrotask(() => {
          const behavior = mockState.behaviors[invocation - 1] ?? (invocation === 1 ? "error" : "ready");
          if (behavior === "pending") {
            return;
          }
          if (behavior === "error") {
            watcher.emit("error", new Error("watch startup failed"));
            return;
          }
          watcher.emit("ready");
        });
        return watcher;
      },
    },
  };
});

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    await task?.();
  }
  mockState.watchInvocations = 0;
  mockState.behaviors = [];
  mockState.ignored = undefined;
  vi.resetModules();
});

describe("watcher readiness", () => {
  it("rejects waitForWatcherReady when chokidar errors before ready", async () => {
    const { CodeIntelService } = await import("../src/core/service.js");
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-watch-error-")));
    const workspacePath = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "src", "index.ts"),
      [
        "export function run(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const service = new CodeIntelService({
      dbPath: path.join(tempRoot, "codeintel.sqlite"),
      enableWatch: true,
    });
    cleanupTasks.push(async () => {
      await service.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });

    await expect(service.waitForWatcherReady(indexed.workspace.workspace_id)).rejects.toThrow(
      "watch startup failed",
    );
  });

  it("recreates a failed watcher on the next full index", async () => {
    const { CodeIntelService } = await import("../src/core/service.js");
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-watch-recovery-")));
    const workspacePath = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "src", "index.ts"),
      [
        "export function run(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const service = new CodeIntelService({
      dbPath: path.join(tempRoot, "codeintel.sqlite"),
      enableWatch: true,
    });
    cleanupTasks.push(async () => {
      await service.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    await expect(service.waitForWatcherReady(workspaceId)).rejects.toThrow("watch startup failed");

    await service.refreshWorkspace(workspaceId, true);

    await expect(service.waitForWatcherReady(workspaceId)).resolves.toBeUndefined();
    expect(mockState.watchInvocations).toBe(2);
  });

  it("rejects pending readiness waiters when a watcher is replaced", async () => {
    mockState.behaviors = ["pending", "ready"];
    const { CodeIntelService } = await import("../src/core/service.js");
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-watch-replaced-")));
    const workspacePath = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspacePath, "src", "index.ts"),
      [
        "export function run(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const service = new CodeIntelService({
      dbPath: path.join(tempRoot, "codeintel.sqlite"),
      enableWatch: true,
    });
    cleanupTasks.push(async () => {
      await service.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const pendingReady = service.waitForWatcherReady(workspaceId);

    fs.writeFileSync(
      path.join(workspacePath, "tsconfig.base.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "./tsconfig.base.json",
        },
        null,
        2,
      ),
      "utf8",
    );

    await service.refreshWorkspace(workspaceId, true);

    await expect(pendingReady).rejects.toThrow(
      `Watcher for ${workspaceId} was disposed before becoming ready`,
    );
    await expect(service.waitForWatcherReady(workspaceId)).resolves.toBeUndefined();
    expect(mockState.watchInvocations).toBe(2);
  });

  it("ignores unrelated files under external fallback watch directories", async () => {
    mockState.behaviors = ["ready"];
    const { CodeIntelService } = await import("../src/core/service.js");
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-watch-external-")));
    const monorepoRoot = path.join(tempRoot, "monorepo");
    const workspacePath = path.join(monorepoRoot, "packages", "app");
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "../../shared/tsconfig.base.json",
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspacePath, "src", "index.ts"),
      [
        "export function run(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const service = new CodeIntelService({
      dbPath: path.join(tempRoot, "codeintel.sqlite"),
      enableWatch: true,
    });
    cleanupTasks.push(async () => {
      await service.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    await service.indexWorkspace({ path: workspacePath });

    const ignored = mockState.ignored;
    const externalRoot = path.join(monorepoRoot, "shared");
    const controlFilePath = path.join(externalRoot, "tsconfig.base.json");
    expect(ignored).toBeDefined();
    expect(ignored!(externalRoot)).toBe(false);
    expect(ignored!(controlFilePath)).toBe(false);
    expect(ignored!(path.join(externalRoot, "notes.txt"))).toBe(true);
    expect(ignored!(path.join(externalRoot, "nested", "notes.txt"))).toBe(true);
  });
});
