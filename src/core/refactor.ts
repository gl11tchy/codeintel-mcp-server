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

export interface MoveEdit {
  filePath: string;
  action: "remove_lines" | "insert_lines" | "replace_import";
  line: number;
  endLine?: number;
  oldText?: string;
  newText: string;
}

export interface MoveResult {
  edits: MoveEdit[];
  filesAffected: number;
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

  moveSymbol(
    workspaceId: string,
    symbolId: string,
    targetFilePath: string,
    dryRun: boolean,
    workspaceRoot: string,
  ): MoveResult {
    const symbol = this.store.getSymbol(symbolId);
    if (!symbol || symbol.workspaceId !== workspaceId) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    const sourceFilePath = symbol.filePath;
    if (sourceFilePath === targetFilePath) {
      throw new Error(`Symbol is already in ${targetFilePath}`);
    }

    const edits: MoveEdit[] = [];
    const warnings: string[] = [];

    // Read the source file to extract the symbol text
    const sourceAbsolutePath = path.join(workspaceRoot, sourceFilePath);
    if (!fs.existsSync(sourceAbsolutePath)) {
      throw new Error(`Source file not found: ${sourceAbsolutePath}`);
    }
    const sourceContent = fs.readFileSync(sourceAbsolutePath, "utf8");
    const sourceLines = sourceContent.split("\n");
    const symbolText = sourceLines.slice(symbol.line - 1, symbol.endLine).join("\n");

    // Check if target file already has a symbol with the same name
    const targetAbsolutePath = path.join(workspaceRoot, targetFilePath);
    if (fs.existsSync(targetAbsolutePath)) {
      const targetContent = fs.readFileSync(targetAbsolutePath, "utf8");
      // Simple check: look for the symbol name as a declaration
      const namePattern = new RegExp(`\\b(function|class|const|let|var|type|interface)\\s+${symbol.name}\\b`);
      if (namePattern.test(targetContent)) {
        warnings.push(`Target file already contains a symbol named '${symbol.name}'`);
      }
    }

    // Edit 1: Remove the symbol from the source file
    edits.push({
      filePath: sourceFilePath,
      action: "remove_lines",
      line: symbol.line,
      endLine: symbol.endLine,
      newText: "",
    });

    // Edit 2: Append the symbol to the target file
    edits.push({
      filePath: targetFilePath,
      action: "insert_lines",
      line: -1, // -1 means append
      newText: symbolText,
    });

    // Edit 3: Update import paths in files that import this symbol from the source file
    const references = this.store.getReferencesForSymbol(workspaceId, symbolId);
    const importRefs = references.filter((ref) => ref.role === "import");

    for (const ref of importRefs) {
      // Skip references in the source file itself
      if (ref.filePath === sourceFilePath) continue;

      const importingAbsolutePath = path.join(workspaceRoot, ref.filePath);
      if (!fs.existsSync(importingAbsolutePath)) continue;

      const importingContent = fs.readFileSync(importingAbsolutePath, "utf8");
      const importingLines = importingContent.split("\n");
      const importLine = importingLines[ref.line - 1];
      if (!importLine) continue;

      // Check if the import line imports other symbols too
      const importedNames = this.extractImportedNames(importLine);
      if (importedNames.length > 1) {
        warnings.push(
          `${ref.filePath}:${ref.line} imports multiple symbols from '${sourceFilePath}' — only the moved symbol's import was updated. You may need to manually split the import.`,
        );
        continue;
      }

      // Compute the new relative import path from the importing file to the target file
      const importingDir = path.dirname(ref.filePath);
      let newRelativePath = path.posix.relative(importingDir, targetFilePath);
      // Strip extension for TS-style imports
      newRelativePath = newRelativePath.replace(/\.(ts|tsx|js|jsx)$/, "");
      if (!newRelativePath.startsWith(".")) {
        newRelativePath = `./${newRelativePath}`;
      }

      // Replace the old module specifier in the import line
      const oldRelativePath = this.extractModuleSpecifier(importLine);
      if (oldRelativePath) {
        const newImportLine = importLine.replace(oldRelativePath, newRelativePath);
        edits.push({
          filePath: ref.filePath,
          action: "replace_import",
          line: ref.line,
          oldText: importLine,
          newText: newImportLine,
        });
      }
    }

    const uniqueFiles = new Set(edits.map((e) => e.filePath));

    if (!dryRun) {
      this.applyMoveEdits(edits, workspaceRoot);
    }

    return {
      edits,
      filesAffected: uniqueFiles.size,
      warnings,
      applied: !dryRun,
    };
  }

  private extractImportedNames(importLine: string): string[] {
    // Match `{ name1, name2 }` or `{ name1 as alias, name2 }` patterns
    const braceMatch = importLine.match(/\{([^}]+)\}/);
    if (!braceMatch) return [];
    return braceMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private extractModuleSpecifier(importLine: string): string | null {
    // Match `from "..."` or `from '...'`
    const match = importLine.match(/from\s+["']([^"']+)["']/);
    return match ? match[1] : null;
  }

  private applyMoveEdits(edits: MoveEdit[], workspaceRoot: string): void {
    // Group edits by file for efficient processing
    const editsByFile = new Map<string, MoveEdit[]>();
    for (const edit of edits) {
      const existing = editsByFile.get(edit.filePath) ?? [];
      existing.push(edit);
      editsByFile.set(edit.filePath, existing);
    }

    for (const [filePath, fileEdits] of editsByFile) {
      const absolutePath = path.join(workspaceRoot, filePath);

      for (const edit of fileEdits) {
        switch (edit.action) {
          case "remove_lines": {
            if (!fs.existsSync(absolutePath)) continue;
            const content = fs.readFileSync(absolutePath, "utf8");
            const lines = content.split("\n");
            const endLine = edit.endLine ?? edit.line;
            // Remove the lines and any trailing blank line
            const before = lines.slice(0, edit.line - 1);
            const after = lines.slice(endLine);
            // Remove a leading blank line from 'after' if present (clean up spacing)
            if (after.length > 0 && after[0].trim() === "") {
              after.shift();
            }
            fs.writeFileSync(absolutePath, before.concat(after).join("\n"), "utf8");
            break;
          }
          case "insert_lines": {
            if (fs.existsSync(absolutePath)) {
              const content = fs.readFileSync(absolutePath, "utf8");
              const newContent = content.trimEnd() + "\n\n" + edit.newText + "\n";
              fs.writeFileSync(absolutePath, newContent, "utf8");
            } else {
              // Create the file
              const dir = path.dirname(absolutePath);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              fs.writeFileSync(absolutePath, edit.newText + "\n", "utf8");
            }
            break;
          }
          case "replace_import": {
            if (!fs.existsSync(absolutePath)) continue;
            const content = fs.readFileSync(absolutePath, "utf8");
            const lines = content.split("\n");
            const lineIndex = edit.line - 1;
            if (lineIndex >= 0 && lineIndex < lines.length && edit.oldText) {
              lines[lineIndex] = edit.newText;
            }
            fs.writeFileSync(absolutePath, lines.join("\n"), "utf8");
            break;
          }
        }
      }
    }
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
