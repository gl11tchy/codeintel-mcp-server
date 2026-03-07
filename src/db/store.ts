import path from "node:path";

import Database from "better-sqlite3";

import { ensureDir, safeJsonParse, sanitizeFtsQuery, splitIdentifier } from "../core/utils.js";
import type {
  CodeSymbol,
  FileMeta,
  ImportBinding,
  IndexedFile,
  RawCall,
  RawReference,
  ResolvedCall,
  ResolvedReference,
  SupportedLanguage,
  WorkspaceConfig,
  WorkspaceRecord,
} from "../types.js";

interface FileRow {
  workspace_id: string;
  file_path: string;
  absolute_path: string;
  language: string;
  text: string;
  size: number;
  mtime_ms: number;
  hash: string;
  imports_json: string;
  references_json: string;
  calls_json: string;
  parse_error: string | null;
}

interface WorkspaceRow {
  workspace_id: string;
  root_path: string;
  display_name: string;
  follow_gitignore: number;
  extra_exclude_globs_json: string;
  indexed_at: string;
  indexed_revision: string;
  file_count: number;
  symbol_count: number;
  watch_status: string;
  watch_error: string | null;
}

interface SymbolRow {
  symbol_id: string;
  workspace_id: string;
  file_path: string;
  name: string;
  qualified_name: string;
  kind: CodeSymbol["kind"];
  language: CodeSymbol["language"];
  signature: string;
  summary: string;
  parent_symbol_id: string | null;
  container_name: string | null;
  line: number;
  end_line: number;
  start_index: number;
  end_index: number;
  content_hash: string;
}

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        follow_gitignore INTEGER NOT NULL DEFAULT 1,
        extra_exclude_globs_json TEXT NOT NULL DEFAULT '[]',
        indexed_at TEXT NOT NULL,
        indexed_revision TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        watch_status TEXT NOT NULL DEFAULT 'idle',
        watch_error TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        language TEXT NOT NULL,
        text TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        hash TEXT NOT NULL,
        imports_json TEXT NOT NULL DEFAULT '[]',
        references_json TEXT NOT NULL DEFAULT '[]',
        calls_json TEXT NOT NULL DEFAULT '[]',
        parse_error TEXT,
        PRIMARY KEY (workspace_id, file_path),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symbols (
        symbol_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        signature TEXT NOT NULL,
        summary TEXT NOT NULL,
        parent_symbol_id TEXT,
        container_name TEXT,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_index INTEGER NOT NULL,
        end_index INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS references_resolved (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        target_symbol_id TEXT,
        referenced_name TEXT NOT NULL,
        qualifier TEXT,
        enclosing_symbol_id TEXT,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        context TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason TEXT NOT NULL,
        role TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS calls_resolved (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        caller_symbol_id TEXT,
        callee_symbol_id TEXT,
        callee_name TEXT NOT NULL,
        qualifier TEXT,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        context TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_workspace ON symbols(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(workspace_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_references_target ON references_resolved(workspace_id, target_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls_resolved(workspace_id, caller_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls_resolved(workspace_id, callee_symbol_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
        workspace_id UNINDEXED,
        file_path UNINDEXED,
        symbol_id UNINDEXED,
        name,
        qualified_name,
        signature,
        summary
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
        workspace_id UNINDEXED,
        file_path UNINDEXED,
        text
      );
    `);
  }

  upsertWorkspace(config: WorkspaceConfig, indexedAt: string, indexedRevision: string): void {
    this.db
      .prepare(`
        INSERT INTO workspaces (
          workspace_id,
          root_path,
          display_name,
          follow_gitignore,
          extra_exclude_globs_json,
          indexed_at,
          indexed_revision
        ) VALUES (
          @workspaceId,
          @rootPath,
          @displayName,
          @followGitignore,
          @extraExcludeGlobsJson,
          @indexedAt,
          @indexedRevision
        )
        ON CONFLICT(workspace_id) DO UPDATE SET
          root_path = excluded.root_path,
          display_name = excluded.display_name,
          follow_gitignore = excluded.follow_gitignore,
          extra_exclude_globs_json = excluded.extra_exclude_globs_json,
          indexed_at = excluded.indexed_at,
          indexed_revision = excluded.indexed_revision
      `)
      .run({
        workspaceId: config.workspaceId,
        rootPath: config.rootPath,
        displayName: config.displayName,
        followGitignore: config.followGitignore ? 1 : 0,
        extraExcludeGlobsJson: JSON.stringify(config.extraExcludeGlobs),
        indexedAt,
        indexedRevision,
      });
  }

  setWorkspaceWatchState(workspaceId: string, watchStatus: string, watchError: string | null): void {
    this.db
      .prepare(`
        UPDATE workspaces
        SET watch_status = ?, watch_error = ?
        WHERE workspace_id = ?
      `)
      .run(watchStatus, watchError, workspaceId);
  }

  setWorkspaceRevision(workspaceId: string, indexedAt: string, indexedRevision: string): void {
    this.db
      .prepare(`
        UPDATE workspaces
        SET indexed_at = ?, indexed_revision = ?
        WHERE workspace_id = ?
      `)
      .run(indexedAt, indexedRevision, workspaceId);
  }

  updateWorkspaceCounts(workspaceId: string): void {
    const fileCount =
      (this.db.prepare("SELECT COUNT(*) AS count FROM files WHERE workspace_id = ?").get(workspaceId) as { count: number }).count ?? 0;
    const symbolCount =
      (this.db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE workspace_id = ?").get(workspaceId) as { count: number }).count ?? 0;

    this.db
      .prepare(`
        UPDATE workspaces
        SET file_count = ?, symbol_count = ?
        WHERE workspace_id = ?
      `)
      .run(fileCount, symbolCount, workspaceId);
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    return row ? this.mapWorkspace(row) : null;
  }

  getWorkspaceByPath(rootPath: string): WorkspaceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE root_path = ?")
      .get(rootPath) as WorkspaceRow | undefined;
    return row ? this.mapWorkspace(row) : null;
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY display_name ASC")
      .all() as WorkspaceRow[];
    return rows.map((row) => this.mapWorkspace(row));
  }

  removeWorkspace(workspaceId: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspaceId);
  }

  clearWorkspaceIndex(workspaceId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM symbols WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM references_resolved WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM calls_resolved WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM symbol_fts WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM file_fts WHERE workspace_id = ?").run(workspaceId);
    });
    transaction();
  }

  saveIndexedFile(file: IndexedFile, symbols: CodeSymbol[]): void {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
            DELETE FROM symbols
            WHERE workspace_id = ? AND file_path = ?
          `,
        )
        .run(file.workspaceId, file.filePath);

      this.db
        .prepare(
          `
            DELETE FROM symbol_fts
            WHERE workspace_id = ? AND file_path = ?
          `,
        )
        .run(file.workspaceId, file.filePath);

      this.db
        .prepare(
          `
            DELETE FROM file_fts
            WHERE workspace_id = ? AND file_path = ?
          `,
        )
        .run(file.workspaceId, file.filePath);

      this.db
        .prepare(
          `
            INSERT INTO files (
              workspace_id,
              file_path,
              absolute_path,
              language,
              text,
              size,
              mtime_ms,
              hash,
              imports_json,
              references_json,
              calls_json,
              parse_error
            ) VALUES (
              @workspaceId,
              @filePath,
              @absolutePath,
              @language,
              @text,
              @size,
              @mtimeMs,
              @hash,
              @importsJson,
              @referencesJson,
              @callsJson,
              @parseError
            )
            ON CONFLICT(workspace_id, file_path) DO UPDATE SET
              absolute_path = excluded.absolute_path,
              language = excluded.language,
              text = excluded.text,
              size = excluded.size,
              mtime_ms = excluded.mtime_ms,
              hash = excluded.hash,
              imports_json = excluded.imports_json,
              references_json = excluded.references_json,
              calls_json = excluded.calls_json,
              parse_error = excluded.parse_error
          `,
        )
        .run({
          workspaceId: file.workspaceId,
          filePath: file.filePath,
          absolutePath: file.absolutePath,
          language: file.language,
          text: file.text,
          size: file.size,
          mtimeMs: file.mtimeMs,
          hash: file.hash,
          importsJson: JSON.stringify(file.imports),
          referencesJson: JSON.stringify(file.references),
          callsJson: JSON.stringify(file.calls),
          parseError: file.parseError,
        });

      this.db
        .prepare("INSERT INTO file_fts(workspace_id, file_path, text) VALUES (?, ?, ?)")
        .run(file.workspaceId, file.filePath, file.text);

      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols (
          symbol_id,
          workspace_id,
          file_path,
          name,
          qualified_name,
          kind,
          language,
          signature,
          summary,
          parent_symbol_id,
          container_name,
          line,
          end_line,
          start_index,
          end_index,
          content_hash
        ) VALUES (
          @id,
          @workspaceId,
          @filePath,
          @name,
          @qualifiedName,
          @kind,
          @language,
          @signature,
          @summary,
          @parentSymbolId,
          @containerName,
          @line,
          @endLine,
          @startIndex,
          @endIndex,
          @contentHash
        )
      `);

      const insertSymbolFts = this.db.prepare(`
        INSERT INTO symbol_fts (
          workspace_id,
          file_path,
          symbol_id,
          name,
          qualified_name,
          signature,
          summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const symbol of symbols) {
        insertSymbol.run(symbol);
        const searchName = `${symbol.name} ${splitIdentifier(symbol.name)}`;
        const searchQualified = `${symbol.qualifiedName} ${splitIdentifier(symbol.qualifiedName)}`;
        insertSymbolFts.run(
          symbol.workspaceId,
          symbol.filePath,
          symbol.id,
          searchName,
          searchQualified,
          symbol.signature,
          symbol.summary,
        );
      }
    });

    transaction();
  }

  removeFile(workspaceId: string, filePath: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE workspace_id = ? AND file_path = ?").run(workspaceId, filePath);
      this.db.prepare("DELETE FROM symbols WHERE workspace_id = ? AND file_path = ?").run(workspaceId, filePath);
      this.db.prepare("DELETE FROM symbol_fts WHERE workspace_id = ? AND file_path = ?").run(workspaceId, filePath);
      this.db.prepare("DELETE FROM file_fts WHERE workspace_id = ? AND file_path = ?").run(workspaceId, filePath);
    });
    transaction();
  }

  getFileMeta(workspaceId: string): FileMeta[] {
    const rows = this.db
      .prepare("SELECT workspace_id, file_path, absolute_path, language, size, mtime_ms, hash FROM files WHERE workspace_id = ? ORDER BY file_path ASC")
      .all(workspaceId) as Array<{workspace_id: string; file_path: string; absolute_path: string; language: string; size: number; mtime_ms: number; hash: string}>;
    return rows.map(row => ({
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      absolutePath: row.absolute_path,
      language: row.language as SupportedLanguage,
      size: row.size,
      mtimeMs: row.mtime_ms,
      hash: row.hash,
    }));
  }

  getFiles(workspaceId: string): IndexedFile[] {
    const rows = this.db
      .prepare("SELECT * FROM files WHERE workspace_id = ? ORDER BY file_path ASC")
      .all(workspaceId) as FileRow[];

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      absolutePath: row.absolute_path,
      language: row.language as IndexedFile["language"],
      text: row.text,
      size: row.size,
      mtimeMs: row.mtime_ms,
      hash: row.hash,
      imports: safeJsonParse<ImportBinding[]>(row.imports_json, []),
      references: safeJsonParse<RawReference[]>(row.references_json, []),
      calls: safeJsonParse<RawCall[]>(row.calls_json, []),
      parseError: row.parse_error,
    }));
  }

  getSymbols(workspaceId: string): CodeSymbol[] {
    const rows = this.db
      .prepare("SELECT * FROM symbols WHERE workspace_id = ? ORDER BY file_path ASC, start_index ASC")
      .all(workspaceId) as SymbolRow[];
    return rows.map((row) => this.mapSymbol(row));
  }

  getFileSymbols(workspaceId: string, filePath: string): CodeSymbol[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM symbols
          WHERE workspace_id = ? AND file_path = ?
          ORDER BY start_index ASC
        `,
      )
      .all(workspaceId, filePath) as SymbolRow[];
    return rows.map((row) => this.mapSymbol(row));
  }

  getSymbol(symbolId: string): CodeSymbol | null {
    const row = this.db.prepare("SELECT * FROM symbols WHERE symbol_id = ?").get(symbolId) as SymbolRow | undefined;
    return row ? this.mapSymbol(row) : null;
  }

  getFile(workspaceId: string, filePath: string): IndexedFile | null {
    const row = this.db
      .prepare("SELECT * FROM files WHERE workspace_id = ? AND file_path = ?")
      .get(workspaceId, filePath) as FileRow | undefined;

    if (!row) {
      return null;
    }

    return {
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      absolutePath: row.absolute_path,
      language: row.language as IndexedFile["language"],
      text: row.text,
      size: row.size,
      mtimeMs: row.mtime_ms,
      hash: row.hash,
      imports: safeJsonParse<ImportBinding[]>(row.imports_json, []),
      references: safeJsonParse<RawReference[]>(row.references_json, []),
      calls: safeJsonParse<RawCall[]>(row.calls_json, []),
      parseError: row.parse_error,
    };
  }

  replaceResolvedRelations(workspaceId: string, references: ResolvedReference[], calls: ResolvedCall[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM references_resolved WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM calls_resolved WHERE workspace_id = ?").run(workspaceId);

      const insertReference = this.db.prepare(`
        INSERT INTO references_resolved (
          workspace_id,
          file_path,
          target_symbol_id,
          referenced_name,
          qualifier,
          enclosing_symbol_id,
          line,
          column,
          context,
          confidence,
          reason,
          role
        ) VALUES (
          @workspaceId,
          @filePath,
          @targetSymbolId,
          @referencedName,
          @qualifier,
          @enclosingSymbolId,
          @line,
          @column,
          @context,
          @confidence,
          @reason,
          @role
        )
      `);

      const insertCall = this.db.prepare(`
        INSERT INTO calls_resolved (
          workspace_id,
          file_path,
          caller_symbol_id,
          callee_symbol_id,
          callee_name,
          qualifier,
          line,
          column,
          context,
          confidence,
          reason
        ) VALUES (
          @workspaceId,
          @filePath,
          @callerSymbolId,
          @calleeSymbolId,
          @calleeName,
          @qualifier,
          @line,
          @column,
          @context,
          @confidence,
          @reason
        )
      `);

      for (const reference of references) {
        insertReference.run(reference);
      }

      for (const call of calls) {
        insertCall.run(call);
      }
    });

    transaction();
  }

  insertResolvedRelations(references: ResolvedReference[], calls: ResolvedCall[]): void {
    if (references.length === 0 && calls.length === 0) return;

    const transaction = this.db.transaction(() => {
      const insertReference = this.db.prepare(`
        INSERT INTO references_resolved (
          workspace_id,
          file_path,
          target_symbol_id,
          referenced_name,
          qualifier,
          enclosing_symbol_id,
          line,
          column,
          context,
          confidence,
          reason,
          role
        ) VALUES (
          @workspaceId,
          @filePath,
          @targetSymbolId,
          @referencedName,
          @qualifier,
          @enclosingSymbolId,
          @line,
          @column,
          @context,
          @confidence,
          @reason,
          @role
        )
      `);

      const insertCall = this.db.prepare(`
        INSERT INTO calls_resolved (
          workspace_id,
          file_path,
          caller_symbol_id,
          callee_symbol_id,
          callee_name,
          qualifier,
          line,
          column,
          context,
          confidence,
          reason
        ) VALUES (
          @workspaceId,
          @filePath,
          @callerSymbolId,
          @calleeSymbolId,
          @calleeName,
          @qualifier,
          @line,
          @column,
          @context,
          @confidence,
          @reason
        )
      `);

      for (const reference of references) {
        insertReference.run(reference);
      }

      for (const call of calls) {
        insertCall.run(call);
      }
    });

    transaction();
  }

  getReferencesForSymbol(workspaceId: string, symbolId: string): ResolvedReference[] {
    return this.db
      .prepare(
        `
          SELECT
            workspace_id AS workspaceId,
            file_path AS filePath,
            target_symbol_id AS targetSymbolId,
            referenced_name AS referencedName,
            qualifier,
            enclosing_symbol_id AS enclosingSymbolId,
            line,
            column,
            context,
            confidence,
            reason,
            role
          FROM references_resolved
          WHERE workspace_id = ? AND target_symbol_id = ?
          ORDER BY file_path ASC, line ASC, column ASC
        `,
      )
      .all(workspaceId, symbolId) as ResolvedReference[];
  }

  getCallsByCaller(workspaceId: string, symbolId: string): ResolvedCall[] {
    return this.db
      .prepare(
        `
          SELECT
            workspace_id AS workspaceId,
            file_path AS filePath,
            caller_symbol_id AS callerSymbolId,
            callee_symbol_id AS calleeSymbolId,
            callee_name AS calleeName,
            qualifier,
            line,
            column,
            context,
            confidence,
            reason
          FROM calls_resolved
          WHERE workspace_id = ? AND caller_symbol_id = ?
          ORDER BY file_path ASC, line ASC, column ASC
        `,
      )
      .all(workspaceId, symbolId) as ResolvedCall[];
  }

  getCallsByCallee(workspaceId: string, symbolId: string): ResolvedCall[] {
    return this.db
      .prepare(
        `
          SELECT
            workspace_id AS workspaceId,
            file_path AS filePath,
            caller_symbol_id AS callerSymbolId,
            callee_symbol_id AS calleeSymbolId,
            callee_name AS calleeName,
            qualifier,
            line,
            column,
            context,
            confidence,
            reason
          FROM calls_resolved
          WHERE workspace_id = ? AND callee_symbol_id = ?
          ORDER BY file_path ASC, line ASC, column ASC
        `,
      )
      .all(workspaceId, symbolId) as ResolvedCall[];
  }

  searchSymbolCandidates(workspaceId: string, query: string): CodeSymbol[] {
    const sanitized = sanitizeFtsQuery(query);
    if (sanitized) {
      try {
        const ftsMatches = this.db
          .prepare(
            `
              SELECT symbol_id FROM symbol_fts
              WHERE workspace_id = ? AND symbol_fts MATCH ?
              LIMIT 250
            `,
          )
          .all(workspaceId, sanitized) as Array<{ symbol_id: string }>;

        if (ftsMatches.length > 0) {
          const placeholders = ftsMatches.map(() => "?").join(",");
          return this.db
            .prepare(`SELECT * FROM symbols WHERE symbol_id IN (${placeholders})`)
            .all(...ftsMatches.map((row) => row.symbol_id))
            .map((row) => this.mapSymbol(row as SymbolRow)) as CodeSymbol[];
        }
      } catch {
        // Fall through to the broader scan.
      }
    }

    return this.getSymbols(workspaceId);
  }

  searchTextCandidateFiles(workspaceId: string, query: string): IndexedFile[] {
    const sanitized = sanitizeFtsQuery(query);
    if (sanitized) {
      try {
        const rows = this.db
          .prepare(
            `
              SELECT f.*
              FROM file_fts ft
              JOIN files f
                ON f.workspace_id = ft.workspace_id
               AND f.file_path = ft.file_path
              WHERE ft.workspace_id = ? AND file_fts MATCH ?
              LIMIT 200
            `,
          )
          .all(workspaceId, sanitized) as FileRow[];
        if (rows.length > 0) {
          return rows.map((row) => ({
            workspaceId: row.workspace_id,
            filePath: row.file_path,
            absolutePath: row.absolute_path,
            language: row.language as IndexedFile["language"],
            text: row.text,
            size: row.size,
            mtimeMs: row.mtime_ms,
            hash: row.hash,
            imports: safeJsonParse<ImportBinding[]>(row.imports_json, []),
            references: safeJsonParse<RawReference[]>(row.references_json, []),
            calls: safeJsonParse<RawCall[]>(row.calls_json, []),
            parseError: row.parse_error,
          }));
        }
      } catch {
        // Fall back to the linear scan below.
      }
    }

    const rows = this.db
      .prepare(
        `
          SELECT * FROM files
          WHERE workspace_id = ? AND instr(lower(text), lower(?)) > 0
          ORDER BY file_path ASC
        `,
      )
      .all(workspaceId, query) as FileRow[];

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      absolutePath: row.absolute_path,
      language: row.language as IndexedFile["language"],
      text: row.text,
      size: row.size,
      mtimeMs: row.mtime_ms,
      hash: row.hash,
      imports: safeJsonParse<ImportBinding[]>(row.imports_json, []),
      references: safeJsonParse<RawReference[]>(row.references_json, []),
      calls: safeJsonParse<RawCall[]>(row.calls_json, []),
      parseError: row.parse_error,
    }));
  }

  deleteRelationsForFiles(workspaceId: string, filePaths: string[]): void {
    if (filePaths.length === 0) return;

    const transaction = this.db.transaction(() => {
      const placeholders = filePaths.map(() => "?").join(",");
      this.db
        .prepare(`DELETE FROM references_resolved WHERE workspace_id = ? AND file_path IN (${placeholders})`)
        .run(workspaceId, ...filePaths);
      this.db
        .prepare(`DELETE FROM calls_resolved WHERE workspace_id = ? AND file_path IN (${placeholders})`)
        .run(workspaceId, ...filePaths);
    });
    transaction();
  }

  getFilesThatImportFrom(workspaceId: string, targetFilePaths: string[]): string[] {
    if (targetFilePaths.length === 0) return [];

    const targetSet = new Set(targetFilePaths);
    const likeClauses = targetFilePaths.map(() => "imports_json LIKE ?").join(" OR ");
    const likeParams = targetFilePaths.map((fp) => `%${fp}%`);

    const rows = this.db
      .prepare(
        `SELECT DISTINCT file_path FROM files WHERE workspace_id = ? AND (${likeClauses})`,
      )
      .all(workspaceId, ...likeParams) as Array<{ file_path: string }>;

    return rows
      .map((row) => row.file_path)
      .filter((fp) => !targetSet.has(fp));
  }

  private mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
    return {
      workspaceId: row.workspace_id,
      rootPath: row.root_path,
      displayName: row.display_name,
      followGitignore: row.follow_gitignore === 1,
      extraExcludeGlobs: safeJsonParse<string[]>(row.extra_exclude_globs_json, []),
      indexedAt: row.indexed_at,
      indexedRevision: row.indexed_revision,
      fileCount: row.file_count,
      symbolCount: row.symbol_count,
      watchStatus: row.watch_status,
      watchError: row.watch_error,
    };
  }

  private mapSymbol(row: SymbolRow): CodeSymbol {
    return {
      id: row.symbol_id,
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      name: row.name,
      qualifiedName: row.qualified_name,
      kind: row.kind,
      language: row.language,
      signature: row.signature,
      summary: row.summary,
      parentSymbolId: row.parent_symbol_id,
      containerName: row.container_name,
      line: row.line,
      endLine: row.end_line,
      startIndex: row.start_index,
      endIndex: row.end_index,
      contentHash: row.content_hash,
    };
  }
}
