# CodeIntel MCP Server

Local-first code intelligence for MCP clients.

CodeIntel turns a source tree into a searchable, structured workspace for agents and developers. Instead of brute-forcing whole files into context, it lets an MCP client jump directly to symbols, outlines, references, call edges, and precise source snippets.

## Why This Exists

Most code-facing MCP servers stop at one of two extremes:

- file search with weak structure
- symbol retrieval without enough navigation depth

CodeIntel is built to sit in the useful middle:

- precise symbol lookup
- whole-workspace text search
- resolved references
- caller and callee traversal
- live local freshness through file watching

It is optimized for personal, local workflows first, with a clean path to remote deployment through Streamable HTTP.

## Highlights

| Capability | What you get |
| --- | --- |
| Symbol navigation | Ranked search across functions, classes, methods, types, and constants |
| Exact retrieval | Fetch only the body and surrounding context for a specific symbol |
| File intelligence | Tree view plus per-file outline |
| Workspace search | Text hits with file, line, and column |
| Reference tracing | Imports, direct usages, and call sites resolved heuristically |
| Call graph traversal | Upstream callers and downstream callees |
| Local-first indexing | JS, TS, TSX, and Python support |
| Fast local storage | SQLite + FTS5 |
| MCP transport options | `stdio` and local Streamable HTTP |

## Supported Languages

- JavaScript
- TypeScript
- TSX
- Python

## Tool Catalog

| Tool | Purpose |
| --- | --- |
| `codeintel_index_workspace` | Index a local workspace and start live watching |
| `codeintel_list_workspaces` | List indexed workspaces |
| `codeintel_get_workspace_status` | Show freshness, revision, and pending changes |
| `codeintel_refresh_workspace` | Force a delta refresh or full rebuild |
| `codeintel_get_file_tree` | Browse indexed files and directories |
| `codeintel_get_file_outline` | Get the symbol hierarchy for a file |
| `codeintel_search_symbols` | Ranked symbol search |
| `codeintel_get_symbol` | Retrieve the exact source for a symbol |
| `codeintel_search_text` | Search indexed file contents |
| `codeintel_find_references` | Find resolved references to a symbol |
| `codeintel_find_callers` | Traverse incoming call edges |
| `codeintel_find_callees` | Traverse outgoing call edges |

## Quick Start

### 1. Install

```bash
npm install
npm run build
```

### 2. Run over stdio

```bash
node dist/index.js --transport stdio
```

### 3. Or run local Streamable HTTP

```bash
node dist/index.js --transport http --host 127.0.0.1 --port 3333
```

Optional runtime flags:

- `--db-path /custom/path/codeintel.sqlite`
- `--disable-watch`

## MCP Client Config

Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "codeintel": {
      "command": "node",
      "args": [
        "/absolute/path/to/codeintel-mcp-server/dist/index.js",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

## Typical Workflows

Ask your MCP client to:

- index a repo and summarize its structure
- find every symbol named `authenticate`
- retrieve only `UserService.login`
- find callers of `Greeter.format`
- search for a string literal without opening the full file
- refresh the workspace after a branch switch

## Architecture

```text
Local workspace
  -> file scan + ignore rules
  -> tree-sitter parse
  -> symbol/reference/call extraction
  -> SQLite + FTS5 index
  -> MCP tools
  -> stdio or Streamable HTTP
```

### Core design choices

- Parser layer: native `tree-sitter` bindings for Node with JS/TS/TSX/Python grammars
- Storage layer: SQLite via `better-sqlite3`, plus FTS5 tables for symbol and text search
- Refresh model: full initial index, delta refresh on demand, optional live watcher updates
- Resolution model: deterministic heuristics for same-file symbols, named imports, namespace imports, and `this` / `self` method calls

## Local Development

```bash
npm run typecheck
npm test
npm run build
```

The repo includes fixed fixture workspaces under `tests/fixtures/` that validate:

- TypeScript symbol extraction and callers
- TSX parsing and text search
- Python method calls and references
- incremental refresh after source changes

## Verification Status

Verified locally with:

- `npm run typecheck`
- `npm test`
- `npm run build`
- stdio transport startup
- local HTTP transport startup and `GET /mcp -> 405`

## Current Scope

This version is intentionally focused on local, read-only intelligence.

Included:

- local workspace indexing
- precise symbol retrieval
- search, references, and call traversal
- live freshness

Not included yet:

- GitHub remote indexing
- semantic / embedding search
- edit or refactor tools
- multi-user auth and hosted deployment workflows

## Evaluations

Fixture-based read-only evaluation prompts live in [`evaluations/fixture-eval.xml`](./evaluations/fixture-eval.xml).

## License

MIT. See [LICENSE](./LICENSE).
