import fs from "node:fs";
import path from "node:path";

export interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

export function readTsconfigPaths(workspaceRoot: string): TsconfigPaths | null {
  for (const filename of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = path.join(workspaceRoot, filename);
    if (!fs.existsSync(configPath)) continue;

    try {
      const raw = fs.readFileSync(configPath, "utf8");
      // Strip comments (// and /* */) — tsconfig allows them
      const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const config = JSON.parse(stripped);
      const compilerOptions = config.compilerOptions ?? {};
      const baseUrl = compilerOptions.baseUrl ?? ".";
      const paths = compilerOptions.paths ?? {};

      if (Object.keys(paths).length === 0 && baseUrl === ".") {
        return null;
      }

      return { baseUrl, paths };
    } catch {
      return null;
    }
  }
  return null;
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

        const candidates = [
          posixRelative,
          `${posixRelative}.ts`,
          `${posixRelative}.tsx`,
          `${posixRelative}.js`,
          `${posixRelative}.jsx`,
          `${posixRelative}/index.ts`,
          `${posixRelative}/index.tsx`,
          `${posixRelative}/index.js`,
          `${posixRelative}/index.jsx`,
        ];

        for (const candidate of candidates) {
          if (knownFiles.has(candidate)) return candidate;
        }
      }
    } else {
      if (moduleSpecifier !== pattern) continue;
      for (const mapping of mappings) {
        const absoluteResolved = path.resolve(absoluteBaseUrl, mapping);
        const relativePath = path.relative(workspaceRoot, absoluteResolved);
        const posixRelative = relativePath.split(path.sep).join("/");

        const candidates = [
          posixRelative,
          `${posixRelative}.ts`,
          `${posixRelative}.tsx`,
          `${posixRelative}.js`,
          `${posixRelative}/index.ts`,
        ];
        for (const candidate of candidates) {
          if (knownFiles.has(candidate)) return candidate;
        }
      }
    }
  }

  // Try baseUrl resolution (imports relative to baseUrl without explicit paths entry)
  if (tsconfigPaths.baseUrl !== ".") {
    const absoluteResolved = path.resolve(absoluteBaseUrl, moduleSpecifier);
    const relativePath = path.relative(workspaceRoot, absoluteResolved);
    const posixRelative = relativePath.split(path.sep).join("/");

    const candidates = [
      posixRelative,
      `${posixRelative}.ts`,
      `${posixRelative}.tsx`,
      `${posixRelative}.js`,
    ];
    for (const candidate of candidates) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  return null;
}
