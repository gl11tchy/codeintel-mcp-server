import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { CodeIntelService } from "../src/core/service.js";
import { createCodeIntelMcpServer } from "../src/mcp/server.js";

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    await task?.();
  }
});

function createHarness() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-mcp-mcp-test-"));
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

async function connectClient(
  service: CodeIntelService,
  options?: { enableRefactors?: boolean },
) {
  const server = createCodeIntelMcpServer(service, options);
  const client = new Client({ name: "codeintel-test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  cleanupTasks.push(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  return client;
}

describe("CodeIntel MCP server", () => {
  it("exposes the read-only default MCP surface and resources", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "ts-lib");
    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const client = await connectClient(service);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("codeintel_get_workspace_status");
    expect(toolNames).not.toContain("codeintel_rename_symbol");
    expect(toolNames).not.toContain("codeintel_move_symbol");

    const statusResult = await client.callTool({
      name: "codeintel_get_workspace_status",
      arguments: {
        workspace_id: workspaceId,
        response_format: "json",
      },
    });
    const status = statusResult.structuredContent as {
      parse_issue_count: number;
      parse_issue_files: string[];
    };
    expect(status.parse_issue_count).toBe(0);
    expect(status.parse_issue_files).toEqual([]);

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    expect(resourceUris).toContain("codeintel://workspaces");
    expect(resourceUris).toContain(`codeintel://workspace/${workspaceId}`);
    expect(resourceUris).toContain(`codeintel://workspace/${workspaceId}/files`);

    const fileListResult = await client.readResource({
      uri: `codeintel://workspace/${workspaceId}/files`,
    });
    const fileList = JSON.parse(fileListResult.contents[0].text as string) as Array<{ file_path: string }>;
    expect(fileList.some((item) => item.file_path === "src/index.ts")).toBe(true);

    const fileContentResult = await client.readResource({
      uri: `codeintel://workspace/${workspaceId}/file/src/index.ts`,
    });
    const fileContent = JSON.parse(fileContentResult.contents[0].text as string) as {
      parse_error: string | null;
      outline: { items: Array<{ qualified_name: string }> };
    };
    expect(fileContent.parse_error).toBeNull();
    expect(fileContent.outline.items.some((item) => item.qualified_name === "run")).toBe(true);
  });

  it("shows refactor tools only when opt-in is enabled and surfaces parse warnings", async () => {
    const { tempRoot, service } = createHarness();
    const workspacePath = copyFixture(tempRoot, "js-app");
    const indexed = await service.indexWorkspace({ path: workspacePath });
    const workspaceId = indexed.workspace.workspace_id;
    const client = await connectClient(service, { enableRefactors: true });

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("codeintel_rename_symbol");
    expect(toolNames).toContain("codeintel_move_symbol");

    const statusResult = await client.callTool({
      name: "codeintel_get_workspace_status",
      arguments: {
        workspace_id: workspaceId,
        response_format: "json",
      },
    });
    const status = statusResult.structuredContent as {
      parse_issue_count: number;
      parse_issue_files: string[];
    };
    expect(status.parse_issue_count).toBe(1);
    expect(status.parse_issue_files).toEqual(["src/broken.js"]);

    const brokenFileResult = await client.readResource({
      uri: `codeintel://workspace/${workspaceId}/file/src/broken.js`,
    });
    const brokenFile = JSON.parse(brokenFileResult.contents[0].text as string) as {
      parse_error: string | null;
    };
    expect(brokenFile.parse_error).toBe("Parser reported syntax recovery.");
  });
});
