import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import envPaths from "env-paths";

import type { SupportedLanguage } from "../types.js";

export const MAX_FILE_BYTES = 1024 * 1024;

export const DEFAULT_EXCLUDE_GLOBS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
];

export const SECRET_PATTERNS = [
  /\.env(?:\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.crt$/i,
  /credentials/i,
];

const LANGUAGE_BY_EXTENSION: Record<string, SupportedLanguage> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
};

export function getPaths() {
  return envPaths("codeintel-mcp-server", { suffix: "" });
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function relativeWorkspacePath(rootPath: string, absolutePath: string): string {
  return toPosixPath(path.relative(rootPath, absolutePath));
}

export function hashText(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

export function stableWorkspaceId(rootPath: string): string {
  const basename = path.basename(rootPath).replace(/[^a-zA-Z0-9_-]+/g, "-") || "workspace";
  return `${basename}-${hashText(rootPath).slice(0, 10)}`;
}

export function languageFromFilePath(filePath: string): SupportedLanguage | null {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

export function isSecretLikePath(filePath: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function isBinaryContent(content: string): boolean {
  if (content.includes("\u0000")) {
    return true;
  }

  const controlCharacters = Array.from(content).filter((char) => {
    const code = char.charCodeAt(0);
    return code < 9 || (code > 13 && code < 32);
  }).length;

  return content.length > 0 && controlCharacters / content.length > 0.1;
}

export function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

export function getLine(value: string, lineNumber: number): string {
  return splitLines(value)[Math.max(0, lineNumber - 1)] ?? "";
}

export function excerptLines(value: string, startLine: number, endLine: number): string {
  return splitLines(value)
    .slice(Math.max(0, startLine - 1), Math.max(startLine - 1, endLine))
    .join("\n");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, maxLength = 200): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function safeJsonParse<T>(value: string | null): T {
  if (!value) {
    return [] as T;
  }
  return JSON.parse(value) as T;
}

export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, ""))
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(" ");
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function readGitRevision(rootPath: string): string {
  const gitEntryPath = path.join(rootPath, ".git");
  if (!fs.existsSync(gitEntryPath)) {
    return "";
  }

  let gitDir = gitEntryPath;
  const stat = fs.statSync(gitEntryPath);
  if (stat.isFile()) {
    const pointer = fs.readFileSync(gitEntryPath, "utf8").trim();
    const match = pointer.match(/^gitdir:\s+(.+)$/);
    if (!match) {
      return "";
    }
    gitDir = path.resolve(rootPath, match[1]);
  }

  const headPath = path.join(gitDir, "HEAD");
  if (!fs.existsSync(headPath)) {
    return "";
  }

  const headValue = fs.readFileSync(headPath, "utf8").trim();
  if (!headValue.startsWith("ref: ")) {
    return headValue;
  }

  const refPath = path.join(gitDir, headValue.slice(5));
  if (!fs.existsSync(refPath)) {
    return "";
  }

  return fs.readFileSync(refPath, "utf8").trim();
}

export function resolveJsImport(
  workspaceRoot: string,
  currentFilePath: string,
  moduleSpecifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!moduleSpecifier.startsWith(".")) {
    return null;
  }

  const fromDirectory = path.posix.dirname(currentFilePath);
  const basePath = path.posix.normalize(path.posix.join(fromDirectory, moduleSpecifier));
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
    `${basePath}/index.js`,
    `${basePath}/index.jsx`,
  ].map((candidate) => toPosixPath(candidate.replace(/^\.\//, "")));

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
    const absoluteCandidate = toPosixPath(path.relative(workspaceRoot, path.resolve(workspaceRoot, candidate)));
    if (knownFiles.has(absoluteCandidate)) {
      return absoluteCandidate;
    }
  }

  return null;
}

export function resolvePythonModule(
  currentFilePath: string,
  moduleSpecifier: string,
  knownFiles: Set<string>,
): string | null {
  const packageDir = path.posix.dirname(currentFilePath);
  const leadingDots = moduleSpecifier.match(/^\.+/)?.[0].length ?? 0;
  const cleanSpecifier = moduleSpecifier.slice(leadingDots);

  let baseDirectory = packageDir;
  for (let index = 1; index < leadingDots; index += 1) {
    baseDirectory = path.posix.dirname(baseDirectory);
  }

  const modulePath = cleanSpecifier.replace(/\./g, "/");
  const normalizedBase = leadingDots > 0 ? path.posix.join(baseDirectory, modulePath) : modulePath;
  const candidates = [
    `${normalizedBase}.py`,
    `${normalizedBase}/__init__.py`,
  ].map((candidate) => toPosixPath(candidate.replace(/^\.\//, "")));

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function findGitRoot(startPath: string): string {
  let cursor = path.resolve(startPath);
  const stats = fs.statSync(cursor);
  if (!stats.isDirectory()) {
    cursor = path.dirname(cursor);
  }

  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, ".git"))) {
      return cursor;
    }
    cursor = path.dirname(cursor);
  }

  return path.resolve(startPath);
}
