#!/usr/bin/env node

import process from "node:process";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

import { CodeIntelService } from "./core/service.js";
import { createCodeIntelMcpServer } from "./mcp/server.js";

interface CliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  dbPath?: string;
  disableWatch: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    transport: "stdio",
    host: "127.0.0.1",
    port: 3333,
    disableWatch: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--transport":
        options.transport = (argv[index + 1] as CliOptions["transport"]) ?? "stdio";
        index += 1;
        break;
      case "--host":
        options.host = argv[index + 1] ?? options.host;
        index += 1;
        break;
      case "--port":
        options.port = Number(argv[index + 1] ?? options.port);
        index += 1;
        break;
      case "--db-path":
        options.dbPath = argv[index + 1];
        index += 1;
        break;
      case "--disable-watch":
        options.disableWatch = true;
        break;
      default:
        break;
    }
  }

  return options;
}

async function runStdio(service: CodeIntelService): Promise<void> {
  const server = createCodeIntelMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codeintel-mcp-server listening on stdio");
}

async function runHttp(service: CodeIntelService, host: string, port: number): Promise<void> {
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (req, res) => {
    const server = createCodeIntelMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error("HTTP transport error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  await new Promise<void>((resolve, reject) => {
    app.listen(port, host, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      console.error(`codeintel-mcp-server listening on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const service = new CodeIntelService({
    dbPath: options.dbPath,
    enableWatch: !options.disableWatch,
  });

  process.on("SIGINT", async () => {
    await service.close();
    process.exit(0);
  });

  if (options.transport === "http") {
    await runHttp(service, options.host, options.port);
    return;
  }

  await runStdio(service);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
