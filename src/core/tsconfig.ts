import fs from "node:fs";
import path from "node:path";

export interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
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

function resolveExtendsChain(configPath: string, maxDepth = 5): Record<string, unknown> {
  let mergedCompilerOptions: Record<string, unknown> = {};

  let currentPath = configPath;
  for (let depth = 0; depth < maxDepth; depth++) {
    const config = parseTsconfigFile(currentPath);
    if (!config) break;

    const currentOptions = (config.compilerOptions ?? {}) as Record<string, unknown>;
    // Child overrides base: spread current (base) first, then accumulated child on top
    mergedCompilerOptions = { ...currentOptions, ...mergedCompilerOptions };

    const extendsValue = config.extends;
    if (typeof extendsValue !== "string") break;

    const currentDir = path.dirname(currentPath);
    currentPath = extendsValue.endsWith(".json")
      ? path.resolve(currentDir, extendsValue)
      : path.resolve(currentDir, `${extendsValue}.json`);
    if (!fs.existsSync(currentPath) && !extendsValue.endsWith(".json")) {
      // Try without appending .json (the original path might resolve as-is via node_modules, etc.)
      currentPath = path.resolve(currentDir, extendsValue);
    }
    if (!fs.existsSync(currentPath)) break;
  }

  return mergedCompilerOptions;
}

export function readTsconfigPaths(workspaceRoot: string): TsconfigPaths | null {
  for (const filename of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = path.join(workspaceRoot, filename);
    if (!fs.existsSync(configPath)) continue;

    try {
      const compilerOptions = resolveExtendsChain(configPath);
      const baseUrl = (compilerOptions.baseUrl as string) ?? ".";
      const paths = (compilerOptions.paths as Record<string, string[]>) ?? {};

      if (Object.keys(paths).length === 0 && !compilerOptions.baseUrl) {
        return null;
      }

      return { baseUrl, paths };
    } catch {
      return null;
    }
  }
  return null;
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

  const absoluteBaseUrl = path.resolve(workspaceRoot, tsconfigPaths.baseUrl);

  for (const [pattern, mappings] of Object.entries(tsconfigPaths.paths)) {
    const hasWildcard = pattern.includes("*");

    if (hasWildcard) {
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      if (!moduleSpecifier.startsWith(prefix)) continue;
      const rest = moduleSpecifier.slice(prefix.length);

      for (const mapping of mappings) {
        const resolved = mapping.replace("*", rest);
        const absoluteResolved = path.resolve(absoluteBaseUrl, resolved);
        const relativePath = path.relative(workspaceRoot, absoluteResolved);
        const posixRelative = relativePath.split(path.sep).join("/");

        for (const candidate of buildCandidates(posixRelative)) {
          if (knownFiles.has(candidate)) return candidate;
        }
      }
    } else {
      if (moduleSpecifier !== pattern) continue;
      for (const mapping of mappings) {
        const absoluteResolved = path.resolve(absoluteBaseUrl, mapping);
        const relativePath = path.relative(workspaceRoot, absoluteResolved);
        const posixRelative = relativePath.split(path.sep).join("/");

        for (const candidate of buildCandidates(posixRelative)) {
          if (knownFiles.has(candidate)) return candidate;
        }
      }
    }
  }

  // Try baseUrl resolution (imports relative to baseUrl without explicit paths entry)
  {
    const absoluteResolved = path.resolve(absoluteBaseUrl, moduleSpecifier);
    const relativePath = path.relative(workspaceRoot, absoluteResolved);
    const posixRelative = relativePath.split(path.sep).join("/");

    for (const candidate of buildCandidates(posixRelative)) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  return null;
}
