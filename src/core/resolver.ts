import type { Store } from "../db/store.js";
import type {
  CodeSymbol,
  Confidence,
  ImportBinding,
  IndexedFile,
  RawCall,
  RawReference,
  ResolvedCall,
  ResolvedReference,
  WorkspaceConfig,
} from "../types.js";
import type { TsconfigPaths } from "./tsconfig.js";
import { resolveAliasedImport } from "./tsconfig.js";
import { resolveJsImport, resolvePythonModule } from "./utils.js";

export interface CandidateBinding {
  binding: ImportBinding;
  targetFilePath: string | null;
  targetSymbolId: string | null;
  confidence: Confidence;
  reason: string;
}

export type LookupMaps = ReturnType<Resolver["buildLookupMaps"]>;

export class Resolver {
  constructor(readonly store: Store) {}

  buildLookupMaps(files: IndexedFile[], symbols: CodeSymbol[]) {
    const filesByPath = new Map(files.map((file) => [file.filePath, file] as const));
    const knownFiles = new Set(files.map((file) => file.filePath));
    const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol] as const));
    const symbolsByName = new Map<string, CodeSymbol[]>();
    const symbolsByFileAndName = new Map<string, Map<string, CodeSymbol[]>>();
    const methodsByClassId = new Map<string, Map<string, CodeSymbol[]>>();

    for (const symbol of symbols) {
      const byName = symbolsByName.get(symbol.name) ?? [];
      byName.push(symbol);
      symbolsByName.set(symbol.name, byName);

      const fileMap = symbolsByFileAndName.get(symbol.filePath) ?? new Map<string, CodeSymbol[]>();
      const fileSymbols = fileMap.get(symbol.name) ?? [];
      fileSymbols.push(symbol);
      fileMap.set(symbol.name, fileSymbols);
      symbolsByFileAndName.set(symbol.filePath, fileMap);

      if (symbol.parentSymbolId) {
        const classMap = methodsByClassId.get(symbol.parentSymbolId) ?? new Map<string, CodeSymbol[]>();
        const entries = classMap.get(symbol.name) ?? [];
        entries.push(symbol);
        classMap.set(symbol.name, entries);
        methodsByClassId.set(symbol.parentSymbolId, classMap);
      }
    }

    return { filesByPath, knownFiles, symbolsById, symbolsByName, symbolsByFileAndName, methodsByClassId };
  }

  resolveFileRelations(
    workspace: WorkspaceConfig,
    file: IndexedFile,
    maps: LookupMaps,
    referenceDedup: Set<string>,
    callDedup: Set<string>,
    tsconfigPaths?: TsconfigPaths | null,
  ): { references: ResolvedReference[]; calls: ResolvedCall[] } {
    const references: ResolvedReference[] = [];
    const calls: ResolvedCall[] = [];

    const bindings = this.resolveBindings(workspace, file, maps.knownFiles, maps.filesByPath, maps.symbolsByFileAndName, tsconfigPaths);
    for (const binding of bindings.values()) {
      if (!binding.targetSymbolId) {
        continue;
      }
      const key = `${file.filePath}:${binding.binding.line}:${binding.binding.column}:${binding.targetSymbolId}:import`;
      if (referenceDedup.has(key)) {
        continue;
      }
      referenceDedup.add(key);
      references.push({
        workspaceId: workspace.workspaceId,
        filePath: file.filePath,
        targetSymbolId: binding.targetSymbolId,
        // Use localName for default imports (that's the identifier in the code),
        // importedName for named imports (the original name before `as` alias)
        referencedName: binding.binding.kind === "default" ? binding.binding.localName : binding.binding.importedName,
        qualifier: null,
        enclosingSymbolId: null,
        line: binding.binding.line,
        column: binding.binding.column,
        context: binding.binding.context,
        confidence: binding.confidence,
        reason: binding.reason,
        role: "import",
      });
    }

    for (const reference of file.references) {
      const resolved = this.resolveReference(
        workspace.workspaceId,
        file.filePath,
        reference,
        bindings,
        maps.symbolsById,
        maps.symbolsByName,
        maps.symbolsByFileAndName,
        maps.methodsByClassId,
      );
      if (!resolved.targetSymbolId) {
        continue;
      }
      const key = `${resolved.filePath}:${resolved.line}:${resolved.column}:${resolved.targetSymbolId}:${resolved.role}`;
      if (referenceDedup.has(key)) {
        continue;
      }
      referenceDedup.add(key);
      references.push(resolved);
    }

    for (const call of file.calls) {
      const resolved = this.resolveCall(
        workspace.workspaceId,
        file.filePath,
        call,
        bindings,
        maps.symbolsById,
        maps.symbolsByName,
        maps.symbolsByFileAndName,
        maps.methodsByClassId,
      );
      const key = `${resolved.filePath}:${resolved.line}:${resolved.column}:${resolved.callerSymbolId}:${resolved.calleeSymbolId ?? resolved.calleeName}`;
      if (callDedup.has(key)) {
        continue;
      }
      callDedup.add(key);
      calls.push(resolved);
    }

    return { references, calls };
  }

  rebuildRelations(workspace: WorkspaceConfig, tsconfigPaths?: TsconfigPaths | null): void {
    const files = this.store.getFiles(workspace.workspaceId);
    const symbols = this.store.getSymbols(workspace.workspaceId);
    const maps = this.buildLookupMaps(files, symbols);

    const references: ResolvedReference[] = [];
    const calls: ResolvedCall[] = [];
    const referenceDedup = new Set<string>();
    const callDedup = new Set<string>();

    for (const file of files) {
      const result = this.resolveFileRelations(workspace, file, maps, referenceDedup, callDedup, tsconfigPaths);
      references.push(...result.references);
      calls.push(...result.calls);
    }

    this.store.replaceResolvedRelations(workspace.workspaceId, references, calls);
  }

  /**
   * Scoped relation rebuild: only re-resolves relations for the changed files
   * and their direct import dependents.
   *
   * Known limitation: the resolver also resolves references via `symbolsByName`
   * when a symbol name is unique across the workspace. Adding or removing a
   * symbol can therefore invalidate references in files that don't directly
   * import the changed file. A full rebuild (`rebuildRelations` / the
   * `codeintel_refresh_workspace --full` tool) is needed to fix stale
   * unique-name references after symbols are added or removed.
   */
  rebuildRelationsForFiles(workspace: WorkspaceConfig, changedFilePaths: string[], tsconfigPaths?: TsconfigPaths | null): void {
    if (changedFilePaths.length === 0) return;

    const dependentPaths = this.store.getFilesThatImportFrom(workspace.workspaceId, changedFilePaths);
    const allAffectedPaths = [...new Set([...changedFilePaths, ...dependentPaths])];

    this.store.deleteRelationsForFiles(workspace.workspaceId, allAffectedPaths);

    const allFiles = this.store.getFiles(workspace.workspaceId);
    const allSymbols = this.store.getSymbols(workspace.workspaceId);
    const maps = this.buildLookupMaps(allFiles, allSymbols);

    const affectedSet = new Set(allAffectedPaths);
    const affectedFiles = allFiles.filter((f) => affectedSet.has(f.filePath));

    const references: ResolvedReference[] = [];
    const calls: ResolvedCall[] = [];
    const referenceDedup = new Set<string>();
    const callDedup = new Set<string>();

    for (const file of affectedFiles) {
      const result = this.resolveFileRelations(workspace, file, maps, referenceDedup, callDedup, tsconfigPaths);
      references.push(...result.references);
      calls.push(...result.calls);
    }

    this.store.insertResolvedRelations(references, calls);
  }

  resolveBindings(
    workspace: WorkspaceConfig,
    file: IndexedFile,
    knownFiles: Set<string>,
    filesByPath: Map<string, IndexedFile>,
    symbolsByFileAndName: Map<string, Map<string, CodeSymbol[]>>,
    tsconfigPaths?: TsconfigPaths | null,
  ): Map<string, CandidateBinding> {
    const bindings = new Map<string, CandidateBinding>();

    for (const binding of file.imports) {
      let targetFilePath =
        file.language === "python"
          ? resolvePythonModule(file.filePath, binding.moduleSpecifier, knownFiles)
          : resolveJsImport(workspace.rootPath, file.filePath, binding.moduleSpecifier, knownFiles);

      // Fall back to tsconfig paths alias resolution for JS/TS imports
      if (!targetFilePath && file.language !== "python" && tsconfigPaths) {
        targetFilePath = resolveAliasedImport(workspace.rootPath, tsconfigPaths, binding.moduleSpecifier, knownFiles);
      }

      let targetSymbolId: string | null = null;
      let confidence: Confidence = "low";
      let reason = targetFilePath ? "Resolved import target file." : "Could not resolve import target file.";

      if (targetFilePath) {
        const targetSymbols = symbolsByFileAndName.get(targetFilePath);
        if (binding.kind !== "namespace" && targetSymbols) {
          const matches =
            binding.importedName === "default"
              ? Array.from(targetSymbols.values())
                  .flat()
                  .filter((symbol) => ["function", "class"].includes(symbol.kind))
              : targetSymbols.get(binding.importedName) ?? [];
          if (matches.length === 1) {
            targetSymbolId = matches[0].id;
            confidence = binding.importedName === "default" ? "medium" : "high";
            reason =
              binding.importedName === "default"
                ? "Resolved default import to the file's primary exported symbol."
                : "Resolved named import to a unique symbol in the target file.";
          } else if (matches.length > 1) {
            targetSymbolId = matches[0].id;
            confidence = "low";
            reason = "Multiple target symbols matched this import; using the first indexed symbol.";
          }
        }
      }

      bindings.set(binding.localName, {
        binding,
        targetFilePath,
        targetSymbolId,
        confidence,
        reason,
      });
    }

    return bindings;
  }

  resolveReference(
    workspaceId: string,
    filePath: string,
    reference: RawReference,
    bindings: Map<string, CandidateBinding>,
    symbolsById: Map<string, CodeSymbol>,
    symbolsByName: Map<string, CodeSymbol[]>,
    symbolsByFileAndName: Map<string, Map<string, CodeSymbol[]>>,
    methodsByClassId: Map<string, Map<string, CodeSymbol[]>>,
  ): ResolvedReference {
    let resolvedSymbol: CodeSymbol | null = null;
    let confidence: Confidence = "low";
    let reason = "No resolution heuristic matched.";

    if ((reference.qualifier === "this" || reference.qualifier === "self" || reference.qualifier === "cls") && reference.enclosingSymbolId) {
      const enclosing = symbolsById.get(reference.enclosingSymbolId);
      if (enclosing?.parentSymbolId) {
        const classMethods = methodsByClassId.get(enclosing.parentSymbolId)?.get(reference.name) ?? [];
        if (classMethods.length === 1) {
          resolvedSymbol = classMethods[0];
          confidence = "high";
          reason = "Resolved through current class method lookup.";
        }
      }
    }

    if (!resolvedSymbol && reference.qualifier && bindings.has(reference.qualifier)) {
      const binding = bindings.get(reference.qualifier)!;
      if (binding.binding.kind === "namespace" && binding.targetFilePath) {
        const namespaceSymbols = symbolsByFileAndName.get(binding.targetFilePath)?.get(reference.name) ?? [];
        if (namespaceSymbols.length === 1) {
          resolvedSymbol = namespaceSymbols[0];
          confidence = "high";
          reason = "Resolved through namespace import and member access.";
        }
      }
    }

    if (!resolvedSymbol && bindings.has(reference.name)) {
      const binding = bindings.get(reference.name)!;
      if (binding.targetSymbolId) {
        resolvedSymbol = symbolsById.get(binding.targetSymbolId) ?? null;
        confidence = binding.confidence;
        reason = binding.reason;
      }
    }

    if (!resolvedSymbol) {
      const localMatches = symbolsByFileAndName.get(filePath)?.get(reference.name) ?? [];
      if (localMatches.length === 1) {
        resolvedSymbol = localMatches[0];
        confidence = "high";
        reason = "Resolved to a unique symbol in the same file.";
      }
    }

    if (!resolvedSymbol) {
      const workspaceMatches = symbolsByName.get(reference.name) ?? [];
      if (workspaceMatches.length === 1) {
        resolvedSymbol = workspaceMatches[0];
        confidence = "medium";
        reason = "Resolved to a unique symbol name across the workspace.";
      }
    }

    return {
      workspaceId,
      filePath,
      targetSymbolId: resolvedSymbol?.id ?? null,
      referencedName: reference.name,
      qualifier: reference.qualifier,
      enclosingSymbolId: reference.enclosingSymbolId,
      line: reference.line,
      column: reference.column,
      context: reference.context,
      confidence,
      reason,
      role: reference.role,
    };
  }

  resolveCall(
    workspaceId: string,
    filePath: string,
    call: RawCall,
    bindings: Map<string, CandidateBinding>,
    symbolsById: Map<string, CodeSymbol>,
    symbolsByName: Map<string, CodeSymbol[]>,
    symbolsByFileAndName: Map<string, Map<string, CodeSymbol[]>>,
    methodsByClassId: Map<string, Map<string, CodeSymbol[]>>,
  ): ResolvedCall {
    const resolved = this.resolveReference(
      workspaceId,
      filePath,
      {
        name: call.calleeName,
        qualifier: call.qualifier,
        role: "call",
        line: call.line,
        column: call.column,
        context: call.context,
        enclosingSymbolId: call.callerSymbolId,
      },
      bindings,
      symbolsById,
      symbolsByName,
      symbolsByFileAndName,
      methodsByClassId,
    );

    return {
      workspaceId: resolved.workspaceId,
      filePath,
      callerSymbolId: call.callerSymbolId,
      calleeSymbolId: resolved.targetSymbolId,
      calleeName: call.calleeName,
      qualifier: call.qualifier,
      line: call.line,
      column: call.column,
      context: call.context,
      confidence: resolved.confidence,
      reason: resolved.reason,
    };
  }
}
