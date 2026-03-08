import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  watchInvocations: 0,
}));

vi.mock("chokidar", async () => {
  const { EventEmitter } = await import("node:events");

  return {
    default: {
      watch: () => {
        mockState.watchInvocations += 1;
        const invocation = mockState.watchInvocations;
        const watcher = new EventEmitter() as EventEmitter & {
          add: (_paths: string | string[]) => void;
          close: () => Promise<void>;
          unwatch: (_paths: string | string[]) => Promise<void>;
        };
        watcher.add = () => {};
        watcher.close = async () => {};
        watcher.unwatch = async () => {};
        queueMicrotask(() => {
          if (invocation === 1) {
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
});
