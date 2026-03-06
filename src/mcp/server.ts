import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { estimateTokens } from "../core/utils.js";
import { CodeIntelService } from "../core/service.js";
import type { FileTreeNode, MetaEnvelope, OutlineNode, ResponseFormat } from "../types.js";

const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Response format: markdown for human-readable output or json for machine-readable structured output.");

const workspaceIdSchema = z.string().min(3).describe("Workspace id returned by codeintel_index_workspace.");
const limitSchema = z.number().int().min(1).max(100).default(20).describe("Maximum number of results to return.");
const offsetSchema = z.number().int().min(0).default(0).describe("Number of results to skip for pagination.");
const pathGlobSchema = z.string().optional().describe("Optional glob filter relative to the indexed workspace root.");

function renderFileTree(nodes: FileTreeNode[], depth = 0): string {
  return nodes
    .map((node) => {
      const prefix = `${"  ".repeat(depth)}- `;
      if (node.type === "directory") {
        const children = node.children?.length ? `\n${renderFileTree(node.children, depth + 1)}` : "";
        return `${prefix}${node.name}/` + children;
      }
      return `${prefix}${node.path} (${node.language}, ${node.symbol_count ?? 0} symbols)`;
    })
    .join("\n");
}

function renderOutline(nodes: OutlineNode[], depth = 0): string {
  return nodes
    .map((node) => {
      const prefix = `${"  ".repeat(depth)}- `;
      const children = node.children.length ? `\n${renderOutline(node.children, depth + 1)}` : "";
      return `${prefix}${node.qualified_name} [${node.kind}] L${node.line}-${node.end_line}\n${"  ".repeat(depth + 1)}${node.signature}${children}`;
    })
    .join("\n");
}

function renderAsText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function makeResult(
  responseFormat: ResponseFormat,
  structuredContent: Record<string, unknown>,
  markdown: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: responseFormat === "json" ? renderAsText(structuredContent) : markdown,
      },
    ],
    structuredContent,
  };
}

function metaWithPagination(meta: MetaEnvelope, pagination?: { total_count: number; limit: number; offset: number; has_more: boolean; next_offset: number | null }) {
  return pagination
    ? {
        ...meta,
        total_count: pagination.total_count,
        limit: pagination.limit,
        offset: pagination.offset,
        has_more: pagination.has_more,
        next_offset: pagination.next_offset,
      }
    : meta;
}

export function createCodeIntelMcpServer(service: CodeIntelService): McpServer {
  const server = new McpServer(
    {
      name: "codeintel-mcp-server",
      version: "0.1.0",
    },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "codeintel_index_workspace",
    {
      title: "Index Workspace",
      description: "Index a local git repository or directory, build the code intelligence store, and start a live watcher.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute or relative path to a local repository or source tree."),
        extra_exclude_globs: z.array(z.string()).optional().describe("Optional additional glob patterns to exclude while indexing."),
        follow_gitignore: z.boolean().default(true).describe("Whether to respect the root .gitignore file during indexing."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, extra_exclude_globs, follow_gitignore, response_format }) => {
      const startedAt = performance.now();
      const result = await service.indexWorkspace({
        path,
        extraExcludeGlobs: extra_exclude_globs,
        followGitignore: follow_gitignore,
      });
      const meta = service.metaForWorkspace(result.workspace.workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      return makeResult(
        response_format,
        { ...result, _meta: meta },
        `Indexed \`${result.workspace.display_name}\` at \`${result.workspace.root_path}\`.\n\n- Workspace ID: \`${result.workspace.workspace_id}\`\n- Files: ${result.workspace.file_count}\n- Symbols: ${result.workspace.symbol_count}\n- Git revision: \`${result.workspace.indexed_revision || "n/a"}\`\n- Watch status: ${result.workspace.watch_status}`,
      );
    },
  );

  server.registerTool(
    "codeintel_list_workspaces",
    {
      title: "List Workspaces",
      description: "List all indexed workspaces, their indexing metadata, and language counts.",
      inputSchema: {
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      const startedAt = performance.now();
      const items = service.listWorkspaces();
      const meta = { timing_ms: Number((performance.now() - startedAt).toFixed(1)), estimated_tokens_avoided: 0 };
      const markdown =
        items.length === 0
          ? "No indexed workspaces."
          : items
              .map(
                (workspace) =>
                  `- \`${workspace.workspace_id}\` ${workspace.display_name}\n  path: ${workspace.root_path}\n  files: ${workspace.file_count}, symbols: ${workspace.symbol_count}, watch: ${workspace.watch_status}`,
              )
              .join("\n");
      return makeResult(response_format, { items, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_get_workspace_status",
    {
      title: "Get Workspace Status",
      description: "Return freshness, revision, pending changes, and language counts for an indexed workspace.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        response_format: responseFormatSchema.default("json"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, response_format }) => {
      const startedAt = performance.now();
      const result = service.getWorkspaceStatus(workspace_id);
      const meta = service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      const markdown = [
        `Workspace \`${result.workspace.display_name}\``,
        "",
        `- Root: ${result.workspace.root_path}`,
        `- Indexed revision: ${result.workspace.indexed_revision || "n/a"}`,
        `- Current revision: ${result.current_git_revision || "n/a"}`,
        `- Dirty: ${result.dirty}`,
        `- Pending changes: ${result.pending_change_count}`,
        `- Watch status: ${result.workspace.watch_status}`,
      ].join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_refresh_workspace",
    {
      title: "Refresh Workspace",
      description: "Force an incremental refresh or a full rebuild for an indexed workspace without modifying source files.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        full: z.boolean().default(false).describe("Set true to rebuild the workspace index from scratch."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, full, response_format }) => {
      const startedAt = performance.now();
      const result = await service.refreshWorkspace(workspace_id, full);
      const meta = service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      return makeResult(
        response_format,
        { ...result, _meta: meta },
        `${full ? "Rebuilt" : "Refreshed"} \`${result.workspace.display_name}\`.\n\n- Files: ${result.workspace.file_count}\n- Symbols: ${result.workspace.symbol_count}\n- Watch status: ${result.workspace.watch_status}`,
      );
    },
  );

  server.registerTool(
    "codeintel_get_file_tree",
    {
      title: "Get File Tree",
      description: "Return the indexed file tree for a workspace, optionally filtered by path prefix.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        path_prefix: z.string().optional().describe("Optional relative directory prefix within the workspace."),
        max_depth: z.number().int().min(1).max(12).default(4).describe("Maximum directory depth to expand."),
        limit: z.number().int().min(1).max(1000).default(200).describe("Maximum number of indexed files to include."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, path_prefix, max_depth, limit, response_format }) => {
      const startedAt = performance.now();
      const items = service.getFileTree(workspace_id, path_prefix, max_depth, limit);
      const meta = service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      return makeResult(
        response_format,
        { items, _meta: meta },
        items.length ? renderFileTree(items) : "No indexed files matched the requested prefix.",
      );
    },
  );

  server.registerTool(
    "codeintel_get_file_outline",
    {
      title: "Get File Outline",
      description: "Return the symbol hierarchy for a single indexed file.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        file_path: z.string().min(1).describe("Relative path to a file within the indexed workspace."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, file_path, response_format }) => {
      const startedAt = performance.now();
      const items = service.getFileOutline(workspace_id, file_path);
      const meta = service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      return makeResult(
        response_format,
        { file_path, items, _meta: meta },
        items.length ? renderOutline(items) : `No indexed symbols found for \`${file_path}\`.`,
      );
    },
  );

  server.registerTool(
    "codeintel_search_symbols",
    {
      title: "Search Symbols",
      description: "Search indexed symbols by name, qualified name, signature, summary, language, kind, and path.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        query: z.string().min(1).describe("Search text used to rank symbols."),
        kinds: z.array(z.enum(["function", "class", "method", "type", "constant"])).optional().describe("Optional list of symbol kinds to include."),
        languages: z.array(z.enum(["javascript", "typescript", "tsx", "python"])).optional().describe("Optional list of languages to include."),
        path_glob: pathGlobSchema,
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, query, kinds, languages, path_glob, limit, offset, response_format }) => {
      const startedAt = performance.now();
      const result = service.searchSymbols({
        workspaceId: workspace_id,
        query,
        kinds,
        languages,
        pathGlob: path_glob,
        limit,
        offset,
      });
      const meta = metaWithPagination(
        service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 }),
        result.pagination,
      );
      const markdown =
        result.items.length === 0
          ? "No symbols matched the query."
          : result.items
              .map(
                (item) =>
                  `- \`${item.qualified_name}\` [${item.kind}] ${item.file_path}:${item.line}\n  ${item.signature}\n  score: ${item.score}`,
              )
              .join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_get_symbol",
    {
      title: "Get Symbol",
      description: "Return the exact body of an indexed symbol plus optional surrounding context lines.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        symbol_id: z.string().min(3).describe("Stable symbol id in the form path::qualified_name#kind."),
        context_lines: z.number().int().min(0).max(20).default(3).describe("Number of surrounding lines to include around the symbol."),
        include_body: z.boolean().default(true).describe("Whether to include the exact symbol body."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, symbol_id, context_lines, include_body, response_format }) => {
      const startedAt = performance.now();
      const result = service.getSymbol(workspace_id, symbol_id, context_lines, include_body);
      const estimatedTokensAvoided = Math.max(0, estimateTokens(result.snippet) - estimateTokens(result.body || ""));
      const meta = service.metaForWorkspace(workspace_id, startedAt, {
        estimated_tokens_avoided: estimatedTokensAvoided,
      });
      const markdown = [
        `Symbol \`${result.symbol.qualified_name}\` [${result.symbol.kind}]`,
        "",
        `- File: ${result.symbol.file_path}`,
        `- Lines: ${result.symbol.line}-${result.symbol.end_line}`,
        "",
        include_body ? "```" : "",
        include_body ? result.body : result.snippet,
        include_body ? "```" : "",
      ]
        .filter(Boolean)
        .join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_search_text",
    {
      title: "Search Text",
      description: "Search indexed file contents and return matching lines with file paths and columns.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        query: z.string().min(1).describe("Case-insensitive text search query."),
        path_glob: pathGlobSchema,
        limit: limitSchema.default(20),
        offset: offsetSchema,
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, query, path_glob, limit, offset, response_format }) => {
      const startedAt = performance.now();
      const result = service.searchText({
        workspaceId: workspace_id,
        query,
        pathGlob: path_glob,
        limit,
        offset,
      });
      const meta = metaWithPagination(
        service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 }),
        result.pagination,
      );
      const markdown =
        result.items.length === 0
          ? "No text matches found."
          : result.items
              .map((item) => `- ${item.file_path}:${item.line}:${item.column}\n  ${item.context}`)
              .join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_find_references",
    {
      title: "Find References",
      description: "Find resolved references to a symbol within the indexed workspace, including imports and calls.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        symbol_id: z.string().min(3).describe("Stable symbol id to resolve references for."),
        include_declaration: z.boolean().default(false).describe("Whether to include the declaration site as the first result."),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum number of references to return."),
        offset: offsetSchema,
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, symbol_id, include_declaration, limit, offset, response_format }) => {
      const startedAt = performance.now();
      const result = service.findReferences(workspace_id, symbol_id, include_declaration, limit, offset);
      const meta = metaWithPagination(
        service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 }),
        result.pagination,
      );
      const markdown =
        result.items.length === 0
          ? "No resolved references found."
          : result.items
              .map(
                (item) =>
                  `- ${item.file_path}:${item.line}:${item.column} [${item.role}, ${item.confidence}]\n  ${item.context}\n  ${item.reason}`,
              )
              .join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_find_callers",
    {
      title: "Find Callers",
      description: "Find caller edges for a symbol, optionally traversing multiple resolved call graph hops.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        symbol_id: z.string().min(3).describe("Stable symbol id to find callers for."),
        depth: z.number().int().min(1).max(4).default(1).describe("Maximum call graph depth to traverse."),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum number of caller edges to return."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, symbol_id, depth, limit, response_format }) => {
      const startedAt = performance.now();
      const result = service.findCallers(workspace_id, symbol_id, depth, limit);
      const meta = service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      const markdown =
        result.items.length === 0
          ? "No resolved callers found."
          : result.items
              .map(
                (item) =>
                  `- depth ${item.depth}: ${item.caller_symbol?.qualified_name ?? "unknown"} -> ${item.callee_symbol?.qualified_name ?? "unknown"}\n  ${item.file_path}:${item.line}:${item.column}\n  ${item.context}\n  ${item.reason}`,
              )
              .join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  server.registerTool(
    "codeintel_find_callees",
    {
      title: "Find Callees",
      description: "Find outgoing call edges for a symbol, including unresolved low-confidence callees when necessary.",
      inputSchema: {
        workspace_id: workspaceIdSchema,
        symbol_id: z.string().min(3).describe("Stable symbol id to find callees for."),
        depth: z.number().int().min(1).max(4).default(1).describe("Maximum call graph depth to traverse."),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum number of callee edges to return."),
        response_format: responseFormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, symbol_id, depth, limit, response_format }) => {
      const startedAt = performance.now();
      const result = service.findCallees(workspace_id, symbol_id, depth, limit);
      const meta = service.metaForWorkspace(workspace_id, startedAt, { estimated_tokens_avoided: 0 });
      const markdown =
        result.items.length === 0
          ? "No callees found."
          : result.items
              .map(
                (item) =>
                  `- depth ${item.depth}: ${item.caller_symbol?.qualified_name ?? "unknown"} -> ${item.callee_symbol?.qualified_name ?? item.callee_name}\n  ${item.file_path}:${item.line}:${item.column}\n  ${item.context}\n  ${item.reason}`,
              )
              .join("\n");
      return makeResult(response_format, { ...result, _meta: meta }, markdown);
    },
  );

  return server;
}
