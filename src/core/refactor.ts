import fs from "node:fs";
import path from "node:path";

import type { Store } from "../db/store.js";

export interface RenameEdit {
  filePath: string;
  line: number;
  column: number;
  oldText: string;
  newText: string;
}

export interface RenameResult {
  edits: RenameEdit[];
  filesAffected: number;
  referencesUpdated: number;
  warnings: string[];
  applied: boolean;
}

export class Refactor {
  constructor(private readonly store: Store) {}

  renameSymbol(
    workspaceId: string,
    symbolId: string,
    newName: string,
    dryRun: boolean,
    workspaceRoot: string,
  ): RenameResult {
    const symbol = this.store.getSymbol(symbolId);
    if (!symbol || symbol.workspaceId !== workspaceId) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
      throw new Error(`Invalid identifier: ${newName}`);
    }

    if (newName === symbol.name) {
      throw new Error(`New name is the same as the current name: ${newName}`);
    }

    const edits: RenameEdit[] = [];
    const warnings: string[] = [];

    // Add the definition site edit
    edits.push({
      filePath: symbol.filePath,
      line: symbol.line,
      column: 1,
      oldText: symbol.name,
      newText: newName,
    });

    // Find all resolved references to this symbol
    const references = this.store.getReferencesForSymbol(workspaceId, symbolId);

    for (const ref of references) {
      if (ref.confidence === "low") {
        warnings.push(
          `Low confidence reference at ${ref.filePath}:${ref.line}:${ref.column} — may need manual verification`,
        );
      }

      edits.push({
        filePath: ref.filePath,
        line: ref.line,
        column: ref.column,
        oldText: ref.referencedName,
        newText: newName,
      });
    }

    const deduped = this.deduplicateEdits(edits);
    const uniqueFiles = new Set(deduped.map((e) => e.filePath));

    if (!dryRun) {
      this.applyEdits(deduped, workspaceRoot);
    }

    return {
      edits: deduped,
      filesAffected: uniqueFiles.size,
      referencesUpdated: deduped.length - 1,
      warnings,
      applied: !dryRun,
    };
  }

  private deduplicateEdits(edits: RenameEdit[]): RenameEdit[] {
    const seen = new Set<string>();
    return edits.filter((edit) => {
      const key = `${edit.filePath}:${edit.line}:${edit.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private applyEdits(edits: RenameEdit[], workspaceRoot: string): void {
    // Group edits by file
    const editsByFile = new Map<string, RenameEdit[]>();
    for (const edit of edits) {
      const existing = editsByFile.get(edit.filePath) ?? [];
      existing.push(edit);
      editsByFile.set(edit.filePath, existing);
    }

    for (const [filePath, fileEdits] of editsByFile) {
      const absolutePath = path.join(workspaceRoot, filePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }

      const content = fs.readFileSync(absolutePath, "utf8");
      const lines = content.split("\n");

      // Sort edits in reverse order (bottom-up, right-to-left) to preserve positions
      const sorted = [...fileEdits].sort((a, b) => {
        if (a.line !== b.line) return b.line - a.line;
        return b.column - a.column;
      });

      for (const edit of sorted) {
        const lineIndex = edit.line - 1;
        if (lineIndex < 0 || lineIndex >= lines.length) continue;

        const line = lines[lineIndex];
        const colIndex = edit.column - 1;

        // Search near the expected column for the old text
        const pos = line.indexOf(edit.oldText, Math.max(0, colIndex - 5));
        if (pos === -1) continue;

        lines[lineIndex] =
          line.slice(0, pos) + edit.newText + line.slice(pos + edit.oldText.length);
      }

      fs.writeFileSync(absolutePath, lines.join("\n"), "utf8");
    }
  }
}
