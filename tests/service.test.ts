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

function createHarness() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-mcp-test-"));
  const dbPath = path.join(tempRoot, "codeintel.sqlite");
  const service = new CodeIntelService({ dbPath, enableWatch: false });

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
    expect(outline.some((node) => node.qualified_name === "Greeter")).toBe(true);

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
