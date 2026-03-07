import * as z from "zod/v4";

// ─── Reusable schema fragments ───────────────────────────────────────────────

const workspaceSummarySchema = z.object({
  workspace_id: z.string(),
  root_path: z.string(),
  display_name: z.string(),
  indexed_at: z.string(),
  indexed_revision: z.string(),
  file_count: z.number(),
  symbol_count: z.number(),
  watch_status: z.string(),
  watch_error: z.nullable(z.string()),
});

const languageCountsSchema = z.record(z.string(), z.number());

const symbolSummarySchema = z.object({
  symbol_id: z.string(),
  file_path: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  kind: z.string(),
  language: z.string(),
  signature: z.string(),
  summary: z.string(),
  line: z.number(),
  end_line: z.number(),
});

const paginationSchema = z.object({
  total_count: z.number(),
  limit: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.nullable(z.number()),
});

const metaSchema = z.object({
  timing_ms: z.number(),
  workspace_id: z.optional(z.string()),
  indexed_revision: z.optional(z.string()),
  watch_status: z.optional(z.string()),
  estimated_tokens_avoided: z.optional(z.number()),
  total_count: z.optional(z.number()),
  limit: z.optional(z.number()),
  offset: z.optional(z.number()),
  has_more: z.optional(z.boolean()),
  next_offset: z.optional(z.nullable(z.number())),
});

// ─── File tree node (recursive) ──────────────────────────────────────────────

const fileTreeNodeSchema: z.ZodType<{
  name: string;
  path: string;
  type: string;
  children?: unknown[];
  language?: string;
  symbol_count?: number;
}> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.string(),
    children: z.optional(z.array(fileTreeNodeSchema)),
    language: z.optional(z.string()),
    symbol_count: z.optional(z.number()),
  }),
);

// ─── Outline node (recursive) ────────────────────────────────────────────────

const outlineNodeSchema: z.ZodType<{
  symbol_id: string;
  name: string;
  qualified_name: string;
  kind: string;
  signature: string;
  summary: string;
  line: number;
  end_line: number;
  children: unknown[];
}> = z.lazy(() =>
  z.object({
    symbol_id: z.string(),
    name: z.string(),
    qualified_name: z.string(),
    kind: z.string(),
    signature: z.string(),
    summary: z.string(),
    line: z.number(),
    end_line: z.number(),
    children: z.array(outlineNodeSchema),
  }),
);

// ─── Per-tool output schemas ─────────────────────────────────────────────────

export const indexWorkspaceOutputSchema = {
  workspace: workspaceSummarySchema,
  languages: languageCountsSchema,
  _meta: metaSchema,
} as const;

export const listWorkspacesOutputSchema = {
  items: z.array(
    workspaceSummarySchema.extend({
      languages: languageCountsSchema,
    }),
  ),
  _meta: metaSchema,
} as const;

export const getWorkspaceStatusOutputSchema = {
  workspace: workspaceSummarySchema,
  languages: languageCountsSchema,
  dirty: z.boolean(),
  pending_change_count: z.number(),
  pending_changed_files: z.array(z.string()),
  pending_removed_files: z.array(z.string()),
  current_git_revision: z.nullable(z.string()),
  _meta: metaSchema,
} as const;

export const refreshWorkspaceOutputSchema = {
  workspace: workspaceSummarySchema,
  languages: languageCountsSchema,
  _meta: metaSchema,
} as const;

export const getFileTreeOutputSchema = {
  items: z.array(fileTreeNodeSchema),
  _meta: metaSchema,
} as const;

export const getFileOutlineOutputSchema = {
  file_path: z.string(),
  items: z.array(outlineNodeSchema),
  _meta: metaSchema,
} as const;

export const searchSymbolsOutputSchema = {
  items: z.array(
    symbolSummarySchema.extend({
      score: z.number(),
    }),
  ),
  pagination: paginationSchema,
  _meta: metaSchema,
} as const;

export const getSymbolOutputSchema = {
  symbol: symbolSummarySchema,
  body: z.string(),
  snippet: z.string(),
  context_start_line: z.number(),
  context_end_line: z.number(),
  _meta: metaSchema,
} as const;

export const searchTextOutputSchema = {
  items: z.array(
    z.object({
      file_path: z.string(),
      language: z.string(),
      line: z.number(),
      column: z.number(),
      context: z.string(),
    }),
  ),
  pagination: paginationSchema,
  _meta: metaSchema,
} as const;

export const findReferencesOutputSchema = {
  symbol: symbolSummarySchema,
  items: z.array(
    z.object({
      file_path: z.string(),
      line: z.number(),
      column: z.number(),
      context: z.string(),
      confidence: z.string(),
      reason: z.string(),
      role: z.string(),
      qualifier: z.nullable(z.string()),
      enclosing_symbol_id: z.nullable(z.string()),
    }),
  ),
  pagination: paginationSchema,
  _meta: metaSchema,
} as const;

const callEdgeSchema = z.object({
  depth: z.number(),
  caller_symbol: z.nullable(symbolSummarySchema),
  callee_symbol: z.nullable(symbolSummarySchema),
  file_path: z.string(),
  line: z.number(),
  column: z.number(),
  context: z.string(),
  confidence: z.string(),
  reason: z.string(),
});

export const findCallersOutputSchema = {
  symbol: symbolSummarySchema,
  items: z.array(callEdgeSchema),
  _meta: metaSchema,
} as const;

export const findCalleesOutputSchema = {
  symbol: symbolSummarySchema,
  items: z.array(
    callEdgeSchema.extend({
      callee_name: z.string(),
    }),
  ),
  _meta: metaSchema,
} as const;

export const renameSymbolOutputSchema = {
  edits: z.array(
    z.object({
      filePath: z.string(),
      line: z.number(),
      column: z.number(),
      oldText: z.string(),
      newText: z.string(),
    }),
  ),
  filesAffected: z.number(),
  referencesUpdated: z.number(),
  warnings: z.array(z.string()),
  applied: z.boolean(),
  _meta: metaSchema,
} as const;

export const moveSymbolOutputSchema = {
  edits: z.array(
    z.object({
      filePath: z.string(),
      action: z.enum(["remove_lines", "insert_lines", "replace_import"]),
      line: z.number(),
      endLine: z.optional(z.number()),
      oldText: z.optional(z.string()),
      newText: z.string(),
    }),
  ),
  filesAffected: z.number(),
  warnings: z.array(z.string()),
  applied: z.boolean(),
  _meta: metaSchema,
} as const;
