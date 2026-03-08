import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

export interface TsconfigPaths {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

export interface TsconfigInfo {
  paths: TsconfigPaths | null;
  configFiles: string[];
}

interface NormalizedCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

function parseTsconfigFile(configPath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    // Strip comments (// and /* */) — tsconfig allows them
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function isRelativeOrAbsoluteExtends(extendsValue: string): boolean {
  return (
    extendsValue === "."
    || extendsValue === ".."
    || extendsValue.startsWith("./")
    || extendsValue.startsWith("../")
    || path.isAbsolute(extendsValue)
  );
}

function resolveExtendsPath(configPath: string, extendsValue: string): string {
  const currentDir = path.dirname(configPath);
  if (!isRelativeOrAbsoluteExtends(extendsValue)) {
    const moduleDirs = getNodeModuleDirs(currentDir);
    const candidates = extendsValue.endsWith(".json")
      ? [extendsValue]
      : [extendsValue, `${extendsValue}.json`];
    for (const candidate of candidates) {
      try {
        return require.resolve(candidate, { paths: [currentDir] });
      } catch {
        for (const moduleDir of moduleDirs) {
          const trackedPath = path.join(moduleDir, candidate);
          if (fs.existsSync(trackedPath)) {
            return trackedPath;
          }
        }
      }
    }

    return path.join(moduleDirs[0] ?? currentDir, candidates[0]);
  }

  let resolvedPath = extendsValue.endsWith(".json")
    ? path.resolve(currentDir, extendsValue)
    : path.resolve(currentDir, `${extendsValue}.json`);
  if (!fs.existsSync(resolvedPath) && !extendsValue.endsWith(".json")) {
    // Try without appending .json (the original path might resolve as-is via node_modules, etc.)
    resolvedPath = path.resolve(currentDir, extendsValue);
  }
  return resolvedPath;
}

function resolveExtendsChain(
  configPath: string,
  visited = new Set<string>(),
): { compilerOptions: NormalizedCompilerOptions; configFiles: string[] } {
  const currentPath = path.resolve(configPath);
  if (visited.has(currentPath)) {
    return {
      compilerOptions: {},
      configFiles: [currentPath],
    };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(currentPath);
  const configFiles = [currentPath];
  const config = parseTsconfigFile(currentPath);
  if (!config) {
    return {
      compilerOptions: {},
      configFiles,
    };
  }

  let mergedCompilerOptions: NormalizedCompilerOptions = {};
  for (const entry of normalizeExtendsEntries(config.extends)) {
    const nextPath = resolveExtendsPath(currentPath, entry);
    if (!configFiles.includes(nextPath)) {
      configFiles.push(nextPath);
    }
    if (!fs.existsSync(nextPath)) {
      continue;
    }

    const extended = resolveExtendsChain(nextPath, nextVisited);
    mergedCompilerOptions = mergeCompilerOptions(mergedCompilerOptions, extended.compilerOptions);
    for (const filePath of extended.configFiles) {
      if (!configFiles.includes(filePath)) {
        configFiles.push(filePath);
      }
    }
  }

  const declaredOptions = normalizeDeclaredCompilerOptions(
    currentPath,
    config.compilerOptions,
    mergedCompilerOptions,
  );

  return {
    compilerOptions: mergeCompilerOptions(mergedCompilerOptions, declaredOptions),
    configFiles,
  };
}

function normalizeExtendsEntries(extendsValue: unknown): string[] {
  if (typeof extendsValue === "string") {
    return [extendsValue];
  }
  if (!Array.isArray(extendsValue)) {
    return [];
  }
  return extendsValue.filter((entry): entry is string => typeof entry === "string");
}

function getNodeModuleDirs(startDir: string): string[] {
  const moduleDirs: string[] = [];
  for (let currentDir = startDir; ; currentDir = path.dirname(currentDir)) {
    moduleDirs.push(path.join(currentDir, "node_modules"));
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
  }
  return moduleDirs;
}

function mergeCompilerOptions(
  base: NormalizedCompilerOptions,
  override: NormalizedCompilerOptions,
): NormalizedCompilerOptions {
  const merged: NormalizedCompilerOptions = { ...base };
  if (override.baseUrl !== undefined) {
    merged.baseUrl = override.baseUrl;
  }
  if (override.paths !== undefined) {
    merged.paths = override.paths;
  }
  return merged;
}

function normalizeDeclaredCompilerOptions(
  configPath: string,
  compilerOptionsValue: unknown,
  inherited: NormalizedCompilerOptions,
): NormalizedCompilerOptions {
  if (!compilerOptionsValue || typeof compilerOptionsValue !== "object" || Array.isArray(compilerOptionsValue)) {
    return {};
  }

  const compilerOptions = compilerOptionsValue as Record<string, unknown>;
  const currentDir = path.dirname(configPath);
  const normalized: NormalizedCompilerOptions = {};
  const inheritedBaseUrl = inherited.baseUrl;
  const effectiveBaseUrl = typeof compilerOptions.baseUrl === "string"
    ? path.resolve(currentDir, compilerOptions.baseUrl)
    : inheritedBaseUrl;

  if (typeof compilerOptions.baseUrl === "string") {
    normalized.baseUrl = effectiveBaseUrl;
  }

  if (compilerOptions.paths && typeof compilerOptions.paths === "object" && !Array.isArray(compilerOptions.paths)) {
    const resolutionBase = effectiveBaseUrl ?? currentDir;
    const normalizedPaths: Record<string, string[]> = {};
    for (const [pattern, mappings] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
      if (!Array.isArray(mappings)) {
        continue;
      }
      normalizedPaths[pattern] = mappings
        .filter((mapping): mapping is string => typeof mapping === "string")
        .map((mapping) => (path.isAbsolute(mapping) ? mapping : path.resolve(resolutionBase, mapping)));
    }
    normalized.paths = normalizedPaths;
  }

  return normalized;
}

export function readTsconfigInfo(workspaceRoot: string): TsconfigInfo {
  for (const filename of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = path.join(workspaceRoot, filename);
    if (!fs.existsSync(configPath)) continue;

    try {
      const { compilerOptions, configFiles } = resolveExtendsChain(configPath);
      const baseUrl = compilerOptions.baseUrl ?? null;
      const paths = compilerOptions.paths ?? {};

      if (Object.keys(paths).length === 0 && !baseUrl) {
        return {
          paths: null,
          configFiles,
        };
      }

      return {
        paths: { baseUrl, paths },
        configFiles,
      };
    } catch {
      return {
        paths: null,
        configFiles: [configPath],
      };
    }
  }
  return {
    paths: null,
    configFiles: [],
  };
}

export function readTsconfigPaths(workspaceRoot: string): TsconfigPaths | null {
  return readTsconfigInfo(workspaceRoot).paths;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function buildCandidates(basePath: string): string[] {
  return [
    basePath,
    ...RESOLVE_EXTENSIONS.map(ext => `${basePath}${ext}`),
    ...RESOLVE_EXTENSIONS.map(ext => `${basePath}/index${ext}`),
  ];
}

export function resolveAliasedImport(
  workspaceRoot: string,
  tsconfigPaths: TsconfigPaths,
  moduleSpecifier: string,
  knownFiles: Set<string>,
): string | null {
  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
    return null;
  }

  const absoluteBaseUrl = tsconfigPaths.baseUrl;

  for (const [pattern, mappings] of Object.entries(tsconfigPaths.paths)) {
    const hasWildcard = pattern.includes("*");

    if (hasWildcard) {
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      if (!moduleSpecifier.startsWith(prefix)) continue;
      const rest = moduleSpecifier.slice(prefix.length);

      for (const mapping of mappings) {
        const resolved = mapping.replace("*", rest);
        const absoluteResolved = path.isAbsolute(resolved)
          ? resolved
          : path.resolve(absoluteBaseUrl ?? workspaceRoot, resolved);
        const relativePath = path.relative(workspaceRoot, absoluteResolved);
        const posixRelative = relativePath.split(path.sep).join("/");

        for (const candidate of buildCandidates(posixRelative)) {
          if (knownFiles.has(candidate)) return candidate;
        }
      }
    } else {
      if (moduleSpecifier !== pattern) continue;
      for (const mapping of mappings) {
        const absoluteResolved = path.isAbsolute(mapping)
          ? mapping
          : path.resolve(absoluteBaseUrl ?? workspaceRoot, mapping);
        const relativePath = path.relative(workspaceRoot, absoluteResolved);
        const posixRelative = relativePath.split(path.sep).join("/");

        for (const candidate of buildCandidates(posixRelative)) {
          if (knownFiles.has(candidate)) return candidate;
        }
      }
    }
  }

  // Try baseUrl resolution (imports relative to baseUrl without explicit paths entry)
  if (absoluteBaseUrl) {
    const absoluteResolved = path.resolve(absoluteBaseUrl, moduleSpecifier);
    const relativePath = path.relative(workspaceRoot, absoluteResolved);
    const posixRelative = relativePath.split(path.sep).join("/");

    for (const candidate of buildCandidates(posixRelative)) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  return null;
}
