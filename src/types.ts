export type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "type"
  | "constant"
  | "property";

export type ResponseFormat = "markdown" | "json";

export type ReferenceRole = "usage" | "import" | "call" | "type";

export type Confidence = "high" | "medium" | "low";

export interface WorkspaceConfig {
  workspaceId: string;
  rootPath: string;
  displayName: string;
  followGitignore: boolean;
  extraExcludeGlobs: string[];
}

export interface WorkspaceRecord extends WorkspaceConfig {
  indexedAt: string;
  indexedRevision: string;
  fileCount: number;
  symbolCount: number;
  watchStatus: string;
  watchError: string | null;
}

export interface FileMeta {
  workspaceId: string;
  filePath: string;
  absolutePath: string;
  language: SupportedLanguage;
  size: number;
  mtimeMs: number;
  hash: string;
}

export interface IndexedFile {
  workspaceId: string;
  filePath: string;
  absolutePath: string;
  language: SupportedLanguage;
  text: string;
  size: number;
  mtimeMs: number;
  hash: string;
  imports: ImportBinding[];
  references: RawReference[];
  calls: RawCall[];
  parseError: string | null;
}

export interface CodeSymbol {
  id: string;
  workspaceId: string;
  filePath: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  language: SupportedLanguage;
  signature: string;
  summary: string;
  parentSymbolId: string | null;
  containerName: string | null;
  line: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  contentHash: string;
}

export interface ImportBinding {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  kind: "named" | "default" | "namespace";
  line: number;
  column: number;
  context: string;
}

export interface RawReference {
  name: string;
  qualifier: string | null;
  role: ReferenceRole;
  line: number;
  column: number;
  context: string;
  enclosingSymbolId: string | null;
}

export interface RawCall {
  calleeName: string;
  qualifier: string | null;
  line: number;
  column: number;
  context: string;
  callerSymbolId: string | null;
}

export interface ParsedFileData {
  language: SupportedLanguage;
  symbols: CodeSymbol[];
  imports: ImportBinding[];
  references: RawReference[];
  calls: RawCall[];
  parseError: string | null;
}

export interface ResolvedReference {
  targetSymbolId: string | null;
  workspaceId: string;
  filePath: string;
  referencedName: string;
  qualifier: string | null;
  enclosingSymbolId: string | null;
  line: number;
  column: number;
  context: string;
  confidence: Confidence;
  reason: string;
  role: ReferenceRole;
}

export interface ResolvedCall {
  workspaceId: string;
  filePath: string;
  callerSymbolId: string | null;
  calleeSymbolId: string | null;
  calleeName: string;
  qualifier: string | null;
  line: number;
  column: number;
  context: string;
  confidence: Confidence;
  reason: string;
}

export interface WorkspaceSummary {
  workspace_id: string;
  root_path: string;
  display_name: string;
  indexed_at: string;
  indexed_revision: string;
  file_count: number;
  symbol_count: number;
  watch_status: string;
  watch_error: string | null;
}

export interface ParseIssueSummary {
  parse_issue_count: number;
  parse_issue_files: string[];
}

export interface SymbolSummary {
  symbol_id: string;
  file_path: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  language: SupportedLanguage;
  signature: string;
  summary: string;
  line: number;
  end_line: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: FileTreeNode[];
  language?: SupportedLanguage;
  symbol_count?: number;
}

export interface OutlineNode {
  symbol_id: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  signature: string;
  summary: string;
  line: number;
  end_line: number;
  children: OutlineNode[];
}

export interface FileOutlineResult {
  file_path: string;
  parse_error: string | null;
  items: OutlineNode[];
}

export interface PaginationEnvelope {
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
}

export interface MetaEnvelope {
  timing_ms: number;
  workspace_id?: string;
  indexed_revision?: string;
  watch_status?: string;
  estimated_tokens_avoided?: number;
  total_count?: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
  next_offset?: number | null;
}

export interface SearchSymbolFilters {
  workspaceId: string;
  query: string;
  kinds?: SymbolKind[];
  languages?: SupportedLanguage[];
  pathGlob?: string;
  limit: number;
  offset: number;
}

export interface SearchTextFilters {
  workspaceId: string;
  query: string;
  pathGlob?: string;
  limit: number;
  offset: number;
}
