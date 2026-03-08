import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CodeIntelService } from "../src/core/service.js";

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    await task?.();
  }
});

function createHarness(enableWatch = false) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-mcp-test-")));
  const dbPath = path.join(tempRoot, "codeintel.sqlite");
  const service = new CodeIntelService({ dbPath, enableWatch });

  cleanupTasks.push(async () => {
    await service.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, service };
}

function copyFixture(tempRoot: string, fixtureName: string) {
  const source = path.join(fixturesRoot, fixtureName);
  const destination = path.join(tempRoot, fixtureName);
  fs.cpSync(source, destination, { recursive: true });
  return destination;
}

function writeWorkspaceFiles(workspacePath: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(workspacePath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  expect(condition()).toBe(true);
}

describe("CodeIntelService", () => {
  it("indexes a TypeScript workspace and resolves symbol references and callers", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");

    const indexed = await service.indexWorkspace({ path: workspacePath });
    expect(indexed.workspace.file_count).toBe(2);
    expect(indexed.workspace.symbol_count).toBeGreaterThanOrEqual(5);

    const symbolSearch = service.searchSymbols({
      workspaceId: indexed.workspace.workspace_id,
      query: "add",
      limit: 10,
      offset: 0,
    });

    const addSymbol = symbolSearch.items.find((item) => item.name === "add");
    expect(addSymbol).toBeDefined();

    const symbolBody = service.getSymbol(indexed.workspace.workspace_id, addSymbol!.symbol_id, 0, true);
    expect(symbolBody.body).toContain("return left + right");

    const references = service.findReferences(indexed.workspace.workspace_id, addSymbol!.symbol_id, true, 20, 0);
    expect(references.items.some((item) => item.file_path === "src/math.ts")).toBe(true);
    expect(references.items.some((item) => item.file_path === "src/index.ts")).toBe(true);

    const callers = service.findCallers(indexed.workspace.workspace_id, addSymbol!.symbol_id, 1, 20);
    expect(callers.items.some((item) => item.caller_symbol?.qualified_name === "run")).toBe(true);
    expect(callers.items.some((item) => item.caller_symbol?.qualified_name === "Calculator.addToTotal")).toBe(true);
  });

  it("indexes TSX and Python fixtures and returns text, outline, and callee data", async () => {
    const { tempRoot, service } = createHarness();
    const reactPath = copyFixture(tempRoot, "react-app");
    const pythonPath = copyFixture(tempRoot, "python-pkg");

    const reactIndexed = await service.indexWorkspace({ path: reactPath });
    const reactSymbols = service.searchSymbols({
      workspaceId: reactIndexed.workspace.workspace_id,
      query: "Greeter",
      limit: 10,
      offset: 0,
    });
    expect(reactSymbols.items.some((item) => item.qualified_name === "Greeter")).toBe(true);

    const textHits = service.searchText({
      workspaceId: reactIndexed.workspace.workspace_id,
      query: "formatGreeting",
      limit: 10,
      offset: 0,
    });
    expect(textHits.items.some((item) => item.file_path.endsWith("Greeter.tsx"))).toBe(true);

    const pythonIndexed = await service.indexWorkspace({ path: pythonPath });
    const outline = service.getFileOutline(pythonIndexed.workspace.workspace_id, "util.py");
    expect(outline.items.some((node) => node.qualified_name === "Greeter")).toBe(true);

    const slugifySymbol = service.searchSymbols({
      workspaceId: pythonIndexed.workspace.workspace_id,
      query: "slugify",
      limit: 10,
      offset: 0,
    }).items.find((item) => item.qualified_name === "slugify");
    expect(slugifySymbol).toBeDefined();

    const references = service.findReferences(pythonIndexed.workspace.workspace_id, slugifySymbol!.symbol_id, false, 20, 0);
    expect(references.items.some((item) => item.file_path === "service.py")).toBe(true);
    expect(references.items.some((item) => item.file_path === "util.py")).toBe(true);

    const greetSymbol = service.searchSymbols({
      workspaceId: pythonIndexed.workspace.workspace_id,
      query: "Greeter.greet",
      limit: 10,
      offset: 0,
    }).items.find((item) => item.qualified_name === "Greeter.greet");
    expect(greetSymbol).toBeDefined();

    const callees = service.findCallees(pythonIndexed.workspace.workspace_id, greetSymbol!.symbol_id, 1, 20);
    expect(callees.items.some((item) => item.callee_symbol?.qualified_name === "Greeter.format")).toBe(true);
  });

  it("resolves tsconfig path aliases (@/* and custom prefixes)", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-alias");

    const indexed = await service.indexWorkspace({ path: workspacePath });
    expect(indexed.workspace.file_count).toBe(3);

    // getUserById is defined in src/lib/helpers.ts
    const helpersSearch = service.searchSymbols({
      workspaceId: indexed.workspace.workspace_id,
      query: "getUserById",
      limit: 10,
      offset: 0,
    });
    const getUserByIdSymbol = helpersSearch.items.find((item) => item.name === "getUserById");
    expect(getUserByIdSymbol).toBeDefined();

    // UserCard.ts imports from "@/lib/helpers" — that should resolve via tsconfig paths
    const refs = service.findReferences(indexed.workspace.workspace_id, getUserByIdSymbol!.symbol_id, true, 20, 0);
    const refFiles = refs.items.map((item) => item.file_path);
    expect(refFiles).toContain("src/lib/helpers.ts"); // declaration
    expect(refFiles).toContain("src/components/UserCard.ts"); // import via @/ alias

    // renderUserCard is defined in src/components/UserCard.ts
    const renderSearch = service.searchSymbols({
      workspaceId: indexed.workspace.workspace_id,
      query: "renderUserCard",
      limit: 10,
      offset: 0,
    });
    const renderSymbol = renderSearch.items.find((item) => item.name === "renderUserCard");
    expect(renderSymbol).toBeDefined();

    // src/index.ts imports from "~components/UserCard" — that should also resolve
    const renderRefs = service.findReferences(indexed.workspace.workspace_id, renderSymbol!.symbol_id, true, 20, 0);
    const renderRefFiles = renderRefs.items.map((item) => item.file_path);
    expect(renderRefFiles).toContain("src/components/UserCard.ts"); // declaration
    expect(renderRefFiles).toContain("src/index.ts"); // import via ~components/ alias
  });

  it("resolves package-based tsconfig extends and tracks shared config changes", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "tsconfig-package-extends");
    const sharedConfigPath = "node_modules/@tsconfig/shared/tsconfig.json";
    const helperSymbolId = "src/helper.ts::helper#function";
    fs.mkdirSync(workspacePath, { recursive: true });

    writeWorkspaceFiles(workspacePath, {
      "tsconfig.json": JSON.stringify(
        {
          extends: "@tsconfig/shared/tsconfig.json",
        },
        null,
        2,
      ),
      "node_modules/@tsconfig/shared/package.json": JSON.stringify(
        {
          name: "@tsconfig/shared",
          version: "1.0.0",
        },
        null,
        2,
      ),
      [sharedConfigPath]: JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "../../..",
            paths: {
              "@lib/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "src/duplicate.ts": [
        "export function helper(): string {",
        '  return "duplicate";',
        "}",
        "",
      ].join("\n"),
      "src/index.ts": [
        'import { helper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(true);

    fs.writeFileSync(
      path.join(workspacePath, sharedConfigPath),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "../../..",
            paths: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const dirtyStatus = service.getWorkspaceStatus(workspaceId);
    expect(dirtyStatus.dirty).toBe(true);
    expect(dirtyStatus.pending_changed_files.some((filePath) => filePath.endsWith(sharedConfigPath))).toBe(true);

    await service.refreshWorkspace(workspaceId, false);

    const refreshedRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(refreshedRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(false);
  });

  it("supports tsconfig extends arrays and later base configs override earlier ones", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "tsconfig-array-extends");
    const sharedConfigPath = "config/tsconfig.shared.json";
    const helperSymbolId = "src/helper.ts::helper#function";
    fs.mkdirSync(workspacePath, { recursive: true });

    writeWorkspaceFiles(workspacePath, {
      "tsconfig.base.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {},
          },
        },
        null,
        2,
      ),
      [sharedConfigPath]: JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "..",
            paths: {
              "@lib/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          extends: [
            "./tsconfig.base.json",
            "./config/tsconfig.shared.json",
          ],
        },
        null,
        2,
      ),
      "src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "src/duplicate.ts": [
        "export function helper(): string {",
        '  return "duplicate";',
        "}",
        "",
      ].join("\n"),
      "src/index.ts": [
        'import { helper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(true);

    fs.writeFileSync(
      path.join(workspacePath, sharedConfigPath),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "..",
            paths: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const dirtyStatus = service.getWorkspaceStatus(workspaceId);
    expect(dirtyStatus.dirty).toBe(true);
    expect(dirtyStatus.pending_changed_files).toContain("config/tsconfig.shared.json");

    await service.refreshWorkspace(workspaceId, false);

    const refreshedRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(refreshedRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(false);
  });

  it("FTS5 search finds camelCase symbols by substring tokens", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-alias");

    const indexed = await service.indexWorkspace({ path: workspacePath });

    // Searching "get" should find "getUserById" thanks to camelCase splitting
    const getSearch = service.searchSymbols({
      workspaceId: indexed.workspace.workspace_id,
      query: "get",
      limit: 10,
      offset: 0,
    });
    expect(getSearch.items.some((item) => item.name === "getUserById")).toBe(true);

    // Searching "User" should find symbols with "User" in camelCase
    const userSearch = service.searchSymbols({
      workspaceId: indexed.workspace.workspace_id,
      query: "User",
      limit: 10,
      offset: 0,
    });
    expect(userSearch.items.some((item) => item.name === "getUserById")).toBe(true);
    expect(userSearch.items.some((item) => item.name === "formatUserName")).toBe(true);
    expect(userSearch.items.some((item) => item.name === "renderUserCard")).toBe(true);
  });

  it("indexes JavaScript and reports parse recovery diagnostics", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "js-app");

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    expect(indexed.languages.javascript).toBe(3);
    expect(indexed.parse_issue_count).toBe(1);
    expect(indexed.parse_issue_files).toEqual(["src/broken.js"]);

    const addSymbol = service.searchSymbols({
      workspaceId,
      query: "add",
      limit: 10,
      offset: 0,
    }).items.find((item) => item.name === "add");
    expect(addSymbol).toBeDefined();

    const refs = service.findReferences(workspaceId, addSymbol!.symbol_id, true, 20, 0);
    expect(refs.items.some((item) => item.file_path === "src/index.js")).toBe(true);

    const outline = service.getFileOutline(workspaceId, "src/broken.js");
    expect(outline.parse_error).toBe("Parser reported syntax recovery.");

    const status = service.getWorkspaceStatus(workspaceId);
    expect(status.parse_issue_count).toBe(1);
    expect(status.parse_issue_files).toEqual(["src/broken.js"]);
  });

  it("rebuilds import-only dependents when an export is renamed during refresh", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "import-only");
    fs.mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceFiles(workspacePath, {
      "src/helper.ts": [
        "export function helper(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "src/importer.ts": [
        'import { helper } from "./helper";',
        "",
        "export const loaded = true;",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    const importEdgesBefore = service.store.db
      .prepare(
        `
          SELECT file_path, target_symbol_id, role
          FROM references_resolved
          WHERE workspace_id = ? AND file_path = ?
          ORDER BY line ASC, column ASC
        `,
      )
      .all(workspaceId, "src/importer.ts") as Array<{
      file_path: string;
      target_symbol_id: string | null;
      role: string;
    }>;
    expect(importEdgesBefore).toEqual([
      {
        file_path: "src/importer.ts",
        target_symbol_id: "src/helper.ts::helper#function",
        role: "import",
      },
    ]);

    fs.writeFileSync(
      path.join(workspacePath, "src/helper.ts"),
      [
        "export function util(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await service.refreshWorkspace(workspaceId, false);

    const importEdgesAfter = service.store.db
      .prepare(
        `
          SELECT file_path, target_symbol_id, role
          FROM references_resolved
          WHERE workspace_id = ? AND file_path = ?
          ORDER BY line ASC, column ASC
        `,
      )
      .all(workspaceId, "src/importer.ts") as Array<{
      file_path: string;
      target_symbol_id: string | null;
      role: string;
    }>;
    expect(importEdgesAfter).toEqual([]);
  });

  it("rebuilds import-only dependents when the imported file is deleted", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "import-delete");
    fs.mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceFiles(workspacePath, {
      "src/helper.ts": [
        "export function helper(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "src/importer.ts": [
        'import { helper } from "./helper";',
        "",
        "export const loaded = true;",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    const importEdgesBefore = service.store.db
      .prepare(
        `
          SELECT file_path, target_symbol_id, role
          FROM references_resolved
          WHERE workspace_id = ? AND file_path = ?
          ORDER BY line ASC, column ASC
        `,
      )
      .all(workspaceId, "src/importer.ts") as Array<{
      file_path: string;
      target_symbol_id: string | null;
      role: string;
    }>;
    expect(importEdgesBefore).toEqual([
      {
        file_path: "src/importer.ts",
        target_symbol_id: "src/helper.ts::helper#function",
        role: "import",
      },
    ]);

    fs.rmSync(path.join(workspacePath, "src/helper.ts"));
    await service.refreshWorkspace(workspaceId, false);

    const importEdgesAfter = service.store.db
      .prepare(
        `
          SELECT file_path, target_symbol_id, role
          FROM references_resolved
          WHERE workspace_id = ? AND file_path = ?
          ORDER BY line ASC, column ASC
        `,
      )
      .all(workspaceId, "src/importer.ts") as Array<{
      file_path: string;
      target_symbol_id: string | null;
      role: string;
    }>;
    expect(importEdgesAfter).toEqual([]);
  });

  it("rebuilds name-based references when uniqueness changes during refresh", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "name-resolution");
    fs.mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceFiles(workspacePath, {
      "src/unique.ts": [
        "export function helper(): string {",
        '  return "one";',
        "}",
        "",
      ].join("\n"),
      "src/consumer.ts": [
        "export function useHelper(): string {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/unique.ts::helper#function";

    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.some((item) => item.file_path === "src/consumer.ts")).toBe(true);

    fs.writeFileSync(
      path.join(workspacePath, "src/duplicate.ts"),
      [
        "export function helper(): string {",
        '  return "two";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await service.refreshWorkspace(workspaceId, false);

    const duplicateRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(duplicateRefs.items.some((item) => item.file_path === "src/consumer.ts")).toBe(false);

    fs.rmSync(path.join(workspacePath, "src/duplicate.ts"));
    await service.refreshWorkspace(workspaceId, false);

    const restoredRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(restoredRefs.items.some((item) => item.file_path === "src/consumer.ts")).toBe(true);
  });

  it("forces a full rebuild when tsconfig path aliases change", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "config-rebuild");
    fs.mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceFiles(workspacePath, {
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {},
          },
        },
        null,
        2,
      ),
      "src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "src/index.ts": [
        'import { helper as importedHelper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return importedHelper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/helper.ts::helper#function";

    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.map((item) => item.file_path)).toEqual(["src/helper.ts"]);

    const tsconfigPath = path.join(workspacePath, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const bumpedTime = new Date(Date.now() + 2000);
    fs.utimesSync(tsconfigPath, bumpedTime, bumpedTime);

    const dirtyStatus = service.getWorkspaceStatus(workspaceId);
    expect(dirtyStatus.pending_changed_files).toContain("tsconfig.json");

    await service.refreshWorkspace(workspaceId, false);

    const refreshedRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(refreshedRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(true);
  });

  it("forces a full rebuild when tsconfig.json is deleted", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = path.join(tempRoot, "config-delete");
    fs.mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceFiles(workspacePath, {
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "src/index.ts": [
        'import { helper as importedHelper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return importedHelper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/helper.ts::helper#function";

    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(true);

    fs.rmSync(path.join(workspacePath, "tsconfig.json"));

    const dirtyStatus = service.getWorkspaceStatus(workspaceId);
    expect(dirtyStatus.dirty).toBe(true);
    expect(dirtyStatus.pending_changed_files).toContain("tsconfig.json");

    await service.refreshWorkspace(workspaceId, false);

    const refreshedRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(refreshedRefs.items.map((item) => item.file_path)).toEqual(["src/helper.ts"]);
  });

  it("rejects outlines for files that are not indexed", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");
    const indexed = await service.indexWorkspace({ path: workspacePath });

    expect(() => service.getFileOutline(indexed.workspace.workspace_id, "src/missing.ts")).toThrow(
      "Indexed file not found: src/missing.ts",
    );
  });

  it("forces a full rebuild when an extended tsconfig file changes", async () => {
    const { tempRoot, service } = createHarness();
    const monorepoRoot = path.join(tempRoot, "monorepo");
    const workspacePath = path.join(monorepoRoot, "packages", "app");
    fs.mkdirSync(workspacePath, { recursive: true });

    const baseConfigPath = path.join(monorepoRoot, "tsconfig.base.json");
    writeWorkspaceFiles(monorepoRoot, {
      "tsconfig.base.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {},
          },
        },
        null,
        2,
      ),
      "packages/app/tsconfig.json": JSON.stringify(
        {
          extends: "../../tsconfig.base.json",
        },
        null,
        2,
      ),
      "packages/app/src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "packages/app/src/index.ts": [
        'import { helper as importedHelper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return importedHelper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/helper.ts::helper#function";

    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.map((item) => item.file_path)).toEqual(["src/helper.ts"]);

    fs.writeFileSync(
      baseConfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib/*": ["packages/app/src/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const dirtyStatus = service.getWorkspaceStatus(workspaceId);
    expect(dirtyStatus.dirty).toBe(true);
    expect(dirtyStatus.pending_changed_files).toContain(baseConfigPath.split(path.sep).join("/"));

    await service.refreshWorkspace(workspaceId, false);

    const refreshedRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(refreshedRefs.items.some((item) => item.file_path === "src/index.ts")).toBe(true);
  });

  it("treats git revision changes as full-rebuild boundaries", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");

    execFileSync("git", ["init", "-b", "main"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.name", "Codex"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: workspacePath });
    execFileSync("git", ["add", "."], { cwd: workspacePath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspacePath });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    execFileSync("git", ["commit", "--allow-empty", "-m", "noop"], { cwd: workspacePath });

    const dirtyStatus = service.getWorkspaceStatus(workspaceId);
    expect(dirtyStatus.dirty).toBe(true);
    expect(dirtyStatus.pending_changed_files).toContain(".git/HEAD");

    await service.refreshWorkspace(workspaceId, false);

    const refreshedStatus = service.getWorkspaceStatus(workspaceId);
    expect(refreshedStatus.dirty).toBe(false);
    expect(refreshedStatus.current_git_revision).toBe(refreshedStatus.workspace.indexed_revision);
  });

  it("rebuilds from watch mode when git revision files change", async () => {
    const { tempRoot, service } = createHarness(true);
    const workspacePath = copyFixture(tempRoot, "ts-lib");

    execFileSync("git", ["init", "-b", "main"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.name", "Codex"], { cwd: workspacePath });
    execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: workspacePath });
    execFileSync("git", ["add", "."], { cwd: workspacePath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspacePath });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const initialRevision = indexed.workspace.indexed_revision;

    await service.waitForWatcherReady(workspaceId);

    execFileSync("git", ["commit", "--allow-empty", "-m", "noop"], { cwd: workspacePath });

    await waitForCondition(() => {
      const status = service.getWorkspaceStatus(workspaceId);
      return status.workspace.indexed_revision !== initialRevision
        && status.current_git_revision === status.workspace.indexed_revision
        && status.pending_change_count === 0;
    }, 8000);
  });

  it("uses the same name-based invalidation logic in watch mode", async () => {
    const { tempRoot, service } = createHarness(true);
    const workspacePath = path.join(tempRoot, "watch-resolution");
    fs.mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceFiles(workspacePath, {
      "src/unique.ts": [
        "export function helper(): string {",
        '  return "one";',
        "}",
        "",
      ].join("\n"),
      "src/consumer.ts": [
        "export function useHelper(): string {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/unique.ts::helper#function";

    await service.waitForWatcherReady(workspaceId);

    fs.writeFileSync(
      path.join(workspacePath, "src/duplicate.ts"),
      [
        "export function helper(): string {",
        '  return "two";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await waitForCondition(() => {
      const refs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
      return !refs.items.some((item) => item.file_path === "src/consumer.ts")
        && service.getWorkspaceStatus(workspaceId).pending_change_count === 0;
    });

    fs.rmSync(path.join(workspacePath, "src/duplicate.ts"));

    await waitForCondition(() => {
      const refs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
      return refs.items.some((item) => item.file_path === "src/consumer.ts")
        && service.getWorkspaceStatus(workspaceId).pending_change_count === 0;
    });
  });

  it("rebuilds from watch mode when an extended tsconfig file changes", async () => {
    const { tempRoot, service } = createHarness(true);
    const monorepoRoot = path.join(tempRoot, "watch-monorepo");
    const workspacePath = path.join(monorepoRoot, "packages", "app");
    fs.mkdirSync(workspacePath, { recursive: true });

    const baseConfigPath = path.join(monorepoRoot, "tsconfig.base.json");
    writeWorkspaceFiles(monorepoRoot, {
      "tsconfig.base.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {},
          },
        },
        null,
        2,
      ),
      "packages/app/tsconfig.json": JSON.stringify(
        {
          extends: "../../tsconfig.base.json",
        },
        null,
        2,
      ),
      "packages/app/src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "packages/app/src/index.ts": [
        'import { helper as importedHelper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return importedHelper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/helper.ts::helper#function";
    await service.waitForWatcherReady(workspaceId);

    fs.writeFileSync(
      baseConfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib/*": ["packages/app/src/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await waitForCondition(() => {
      const refs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
      return refs.items.some((item) => item.file_path === "src/index.ts")
        && service.getWorkspaceStatus(workspaceId).pending_change_count === 0;
    }, 8000);
  }, 10000);

  it("rebuilds from watch mode when control paths move under ignored directories", async () => {
    const { tempRoot, service } = createHarness(true);
    const workspacePath = path.join(tempRoot, "watch-dynamic-config");
    const sharedConfigPath = "node_modules/@shared/tsconfig.alias.json";
    fs.mkdirSync(workspacePath, { recursive: true });

    writeWorkspaceFiles(workspacePath, {
      "tsconfig.local.json": JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {},
          },
        },
        null,
        2,
      ),
      "tsconfig.json": JSON.stringify(
        {
          extends: "./tsconfig.local.json",
        },
        null,
        2,
      ),
      "node_modules/@shared/package.json": JSON.stringify(
        {
          name: "@shared",
          version: "1.0.0",
        },
        null,
        2,
      ),
      [sharedConfigPath]: JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "../..",
            paths: {
              "@lib/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "src/helper.ts": [
        "export function helper(): string {",
        '  return "ok";',
        "}",
        "",
      ].join("\n"),
      "src/duplicate.ts": [
        "export function helper(): string {",
        '  return "duplicate";',
        "}",
        "",
      ].join("\n"),
      "src/index.ts": [
        'import { helper } from "@lib/helper";',
        "",
        "export function run(): string {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
    });

    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const helperSymbolId = "src/helper.ts::helper#function";

    const initialRefs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
    expect(initialRefs.items.map((item) => item.file_path)).toEqual(["src/helper.ts"]);

    await service.waitForWatcherReady(workspaceId);

    fs.writeFileSync(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "@shared/tsconfig.alias.json",
        },
        null,
        2,
      ),
      "utf8",
    );

    await waitForCondition(() => {
      const refs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
      return refs.items.some((item) => item.file_path === "src/index.ts")
        && service.getWorkspaceStatus(workspaceId).pending_change_count === 0;
    }, 8000);

    await service.waitForWatcherReady(workspaceId);

    fs.writeFileSync(
      path.join(workspacePath, sharedConfigPath),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "../..",
            paths: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await waitForCondition(() => {
      const refs = service.findReferences(workspaceId, helperSymbolId, true, 20, 0);
      return !refs.items.some((item) => item.file_path === "src/index.ts")
        && service.getWorkspaceStatus(workspaceId).pending_change_count === 0;
    }, 8000);
  }, 12000);

  it("renames a symbol in dry-run mode and then applies the rename", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");
    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    // Find the `add` symbol
    const addSymbol = service.searchSymbols({
      workspaceId,
      query: "add",
      limit: 10,
      offset: 0,
    }).items.find((item) => item.name === "add");
    expect(addSymbol).toBeDefined();

    // Dry-run rename to `addNumbers`
    const dryResult = service.renameSymbol(workspaceId, addSymbol!.symbol_id, "addNumbers", true);
    expect(dryResult.applied).toBe(false);
    expect(dryResult.filesAffected).toBeGreaterThanOrEqual(2);
    expect(dryResult.edits.some((e) => e.filePath === "src/math.ts")).toBe(true);
    expect(dryResult.edits.some((e) => e.filePath === "src/index.ts")).toBe(true);
    expect(dryResult.edits.every((e) => e.oldText === "add" && e.newText === "addNumbers")).toBe(true);

    // Verify files are unchanged after dry run
    const mathContent = fs.readFileSync(path.join(workspacePath, "src/math.ts"), "utf8");
    expect(mathContent).toContain("function add(");

    // Apply the rename
    const applyResult = service.renameSymbol(workspaceId, addSymbol!.symbol_id, "addNumbers", false);
    expect(applyResult.applied).toBe(true);
    expect(applyResult.filesAffected).toBeGreaterThanOrEqual(2);

    // Verify file contents actually changed
    const mathContentAfter = fs.readFileSync(path.join(workspacePath, "src/math.ts"), "utf8");
    expect(mathContentAfter).toContain("function addNumbers(");
    expect(mathContentAfter).not.toContain("function add(");

    const indexContentAfter = fs.readFileSync(path.join(workspacePath, "src/index.ts"), "utf8");
    expect(indexContentAfter).toContain("addNumbers");

    // Verify re-indexing finds the symbol under the new name
    const newSearch = service.searchSymbols({
      workspaceId,
      query: "addNumbers",
      limit: 10,
      offset: 0,
    });
    expect(newSearch.items.some((item) => item.name === "addNumbers")).toBe(true);
    expect(
      service.searchSymbols({ workspaceId, query: "add", limit: 10, offset: 0 })
        .items.every((item) => item.name !== "add"),
    ).toBe(true);
  });

  it("moves a symbol to a different file in dry-run and then applies", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");
    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;

    // Find the `multiply` function in src/math.ts
    const multiplySymbol = service.searchSymbols({
      workspaceId,
      query: "multiply",
      limit: 10,
      offset: 0,
    }).items.find((item) => item.name === "multiply");
    expect(multiplySymbol).toBeDefined();

    // Dry-run move to src/extra.ts
    const dryResult = service.moveSymbol(workspaceId, multiplySymbol!.symbol_id, "src/extra.ts", true);
    expect(dryResult.applied).toBe(false);
    expect(dryResult.edits.length).toBeGreaterThanOrEqual(2);
    expect(dryResult.edits.some((e) => e.filePath === "src/math.ts" && e.action === "remove_lines")).toBe(true);
    expect(dryResult.edits.some((e) => e.filePath === "src/extra.ts" && e.action === "insert_lines")).toBe(true);

    // Verify files are unchanged after dry run
    const mathContent = fs.readFileSync(path.join(workspacePath, "src/math.ts"), "utf8");
    expect(mathContent).toContain("function multiply(");
    expect(fs.existsSync(path.join(workspacePath, "src/extra.ts"))).toBe(false);

    // Apply the move
    const applyResult = service.moveSymbol(workspaceId, multiplySymbol!.symbol_id, "src/extra.ts", false);
    expect(applyResult.applied).toBe(true);
    expect(applyResult.filesAffected).toBeGreaterThanOrEqual(2);

    // Verify src/extra.ts exists and contains the function
    const extraContent = fs.readFileSync(path.join(workspacePath, "src/extra.ts"), "utf8");
    expect(extraContent).toContain("function multiply(");

    // Verify src/math.ts no longer contains the function
    const mathContentAfter = fs.readFileSync(path.join(workspacePath, "src/math.ts"), "utf8");
    expect(mathContentAfter).not.toContain("function multiply(");
    // Other symbols should still be present
    expect(mathContentAfter).toContain("function add(");

    // Re-indexing finds the symbol in the new location
    const newSearch = service.searchSymbols({
      workspaceId,
      query: "multiply",
      limit: 10,
      offset: 0,
    });
    const movedSymbol = newSearch.items.find((item) => item.name === "multiply");
    expect(movedSymbol).toBeDefined();
    expect(movedSymbol!.file_path).toBe("src/extra.ts");
  });

  it("refreshes an indexed workspace after a file change", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");
    const indexed = await service.indexWorkspace({ path: workspacePath });

    const extraFilePath = path.join(workspacePath, "src", "extra.ts");
    fs.writeFileSync(
      extraFilePath,
      [
        'import { add } from "./math";',
        "",
        "export function increment(value: number): number {",
        "  return add(value, 1);",
        "}",
        "",
      ].join("\n"),
    );

    await service.refreshWorkspace(indexed.workspace.workspace_id, false);

    const incrementSymbol = service.searchSymbols({
      workspaceId: indexed.workspace.workspace_id,
      query: "increment",
      limit: 10,
      offset: 0,
    }).items.find((item) => item.qualified_name === "increment");

    expect(incrementSymbol).toBeDefined();
    expect(service.getWorkspaceStatus(indexed.workspace.workspace_id).pending_change_count).toBe(0);
  });
});
