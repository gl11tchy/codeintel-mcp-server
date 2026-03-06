import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScript from "tree-sitter-typescript";

import {
  getLine,
  hashText,
  normalizeWhitespace,
  truncate,
} from "../core/utils.js";
import type {
  CodeSymbol,
  ImportBinding,
  ParsedFileData,
  RawCall,
  RawReference,
  SupportedLanguage,
  SymbolKind,
} from "../types.js";

type SyntaxNode = Parser.SyntaxNode;

interface SymbolFrame {
  symbol: CodeSymbol;
  classSymbol: CodeSymbol | null;
  executableSymbol: CodeSymbol | null;
}

const PARSERS: Record<SupportedLanguage, Parser> = {
  javascript: createParser(JavaScript),
  typescript: createParser(TypeScript.typescript),
  tsx: createParser(TypeScript.tsx),
  python: createParser(Python),
};

function createParser(language: unknown): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

function isIdentifierNode(node: SyntaxNode | null): node is SyntaxNode {
  if (!node) {
    return false;
  }

  return ["identifier", "property_identifier", "type_identifier"].includes(node.type);
}

function isUpperSnakeCase(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value);
}

function makeSymbolId(
  filePath: string,
  qualifiedName: string,
  kind: SymbolKind,
  counts: Map<string, number>,
): string {
  const base = `${filePath}::${qualifiedName}#${kind}`;
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}~${count}`;
}

function signatureFromNode(node: SyntaxNode, bodyNode: SyntaxNode | null): string {
  const raw = bodyNode ? node.text.slice(0, Math.max(0, bodyNode.startIndex - node.startIndex)) : node.text;
  return truncate(normalizeWhitespace(raw), 220);
}

function summaryFromNode(node: SyntaxNode, signature: string, language: SupportedLanguage): string {
  if (language !== "python") {
    return signature;
  }

  const body = node.childForFieldName("body");
  const firstStatement = body?.namedChild(0);
  if (
    firstStatement?.type === "expression_statement" &&
    firstStatement.firstNamedChild?.type === "string"
  ) {
    return truncate(
      normalizeWhitespace(firstStatement.firstNamedChild.text.replace(/^['"]{1,3}|['"]{1,3}$/g, "")),
      220,
    );
  }

  return signature;
}

function fieldEquals(parent: SyntaxNode | null, fieldName: string, candidate: SyntaxNode): boolean {
  return parent?.childForFieldName(fieldName)?.id === candidate.id;
}

function maybeCreateJsSymbol(
  workspaceId: string,
  filePath: string,
  node: SyntaxNode,
  ancestors: CodeSymbol[],
  counts: Map<string, number>,
  language: SupportedLanguage,
): CodeSymbol | null {
  let kind: SymbolKind | null = null;
  let nameNode: SyntaxNode | null = null;
  let bodyNode: SyntaxNode | null = null;

  switch (node.type) {
    case "class_declaration":
      kind = "class";
      nameNode = node.childForFieldName("name");
      bodyNode = node.childForFieldName("body");
      break;
    case "function_declaration":
      kind = "function";
      nameNode = node.childForFieldName("name");
      bodyNode = node.childForFieldName("body");
      break;
    case "method_definition":
      kind = "method";
      nameNode = node.childForFieldName("name");
      bodyNode = node.childForFieldName("body");
      break;
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration":
      kind = "type";
      nameNode = node.childForFieldName("name");
      bodyNode = node.childForFieldName("body");
      break;
    case "variable_declarator": {
      const valueNode = node.childForFieldName("value");
      const declaratorName = node.childForFieldName("name");
      if (!declaratorName || !valueNode) {
        return null;
      }

      if (["arrow_function", "function", "function_expression"].includes(valueNode.type)) {
        kind = "function";
        nameNode = declaratorName;
        bodyNode = valueNode.childForFieldName("body");
      } else if (ancestors.length === 0 && isUpperSnakeCase(declaratorName.text)) {
        kind = "constant";
        nameNode = declaratorName;
        bodyNode = valueNode;
      }
      break;
    }
    default:
      break;
  }

  if (!kind || !nameNode) {
    return null;
  }

  const name = nameNode.text;
  const qualifiedName = [...ancestors.map((ancestor) => ancestor.name), name].join(".");
  const id = makeSymbolId(filePath, qualifiedName, kind, counts);
  const signature = signatureFromNode(node, bodyNode);
  return {
    id,
    workspaceId,
    filePath,
    name,
    qualifiedName,
    kind,
    language,
    signature,
    summary: summaryFromNode(node, signature, language),
    parentSymbolId: ancestors.at(-1)?.id ?? null,
    containerName: ancestors.at(-1)?.qualifiedName ?? null,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    contentHash: hashText(node.text),
  };
}

function maybeCreatePythonSymbol(
  workspaceId: string,
  filePath: string,
  node: SyntaxNode,
  ancestors: CodeSymbol[],
  counts: Map<string, number>,
): CodeSymbol | null {
  let kind: SymbolKind | null = null;
  let nameNode: SyntaxNode | null = null;

  switch (node.type) {
    case "class_definition":
      kind = "class";
      nameNode = node.childForFieldName("name");
      break;
    case "function_definition":
    case "async_function_definition":
      kind = ancestors.at(-1)?.kind === "class" ? "method" : "function";
      nameNode = node.childForFieldName("name");
      break;
    case "assignment":
    case "annotated_assignment": {
      if (ancestors.length > 0) {
        return null;
      }
      const left = node.childForFieldName("left") ?? node.firstNamedChild;
      if (!isIdentifierNode(left) || !isUpperSnakeCase(left.text)) {
        return null;
      }
      kind = "constant";
      nameNode = left;
      break;
    }
    default:
      break;
  }

  if (!kind || !nameNode) {
    return null;
  }

  const name = nameNode.text;
  const qualifiedName = [...ancestors.map((ancestor) => ancestor.name), name].join(".");
  const id = makeSymbolId(filePath, qualifiedName, kind, counts);
  const bodyNode = node.childForFieldName("body");
  const signature = signatureFromNode(node, bodyNode);
  return {
    id,
    workspaceId,
    filePath,
    name,
    qualifiedName,
    kind,
    language: "python",
    signature,
    summary: summaryFromNode(node, signature, "python"),
    parentSymbolId: ancestors.at(-1)?.id ?? null,
    containerName: ancestors.at(-1)?.qualifiedName ?? null,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    contentHash: hashText(node.text),
  };
}

function extractJsImports(content: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const namedMatch = line.match(/import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]+)\}\s+from\s+["'](.+?)["']/);
    if (namedMatch) {
      const [, defaultName, specifierList, moduleSpecifier] = namedMatch;
      if (defaultName) {
        bindings.push({
          localName: defaultName,
          importedName: "default",
          moduleSpecifier,
          kind: "default",
          line: index + 1,
          column: line.indexOf(defaultName) + 1,
          context: line.trim(),
        });
      }
      specifierList.split(",").forEach((entry) => {
        const [importedRaw, aliasRaw] = entry.split(/\s+as\s+/).map((part) => part.trim()).filter(Boolean);
        if (!importedRaw) {
          return;
        }
        const localName = aliasRaw || importedRaw;
        bindings.push({
          localName,
          importedName: importedRaw,
          moduleSpecifier,
          kind: "named",
          line: index + 1,
          column: line.indexOf(localName) + 1,
          context: line.trim(),
        });
      });
      return;
    }

    const namespaceMatch = line.match(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](.+?)["']/);
    if (namespaceMatch) {
      const [, localName, moduleSpecifier] = namespaceMatch;
      bindings.push({
        localName,
        importedName: "*",
        moduleSpecifier,
        kind: "namespace",
        line: index + 1,
        column: line.indexOf(localName) + 1,
        context: line.trim(),
      });
      return;
    }

    const defaultMatch = line.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](.+?)["']/);
    if (defaultMatch) {
      const [, localName, moduleSpecifier] = defaultMatch;
      bindings.push({
        localName,
        importedName: "default",
        moduleSpecifier,
        kind: "default",
        line: index + 1,
        column: line.indexOf(localName) + 1,
        context: line.trim(),
      });
      return;
    }

    const requireNamedMatch = line.match(/const\s+\{([^}]+)\}\s*=\s*require\(["'](.+?)["']\)/);
    if (requireNamedMatch) {
      const [, specifierList, moduleSpecifier] = requireNamedMatch;
      specifierList.split(",").forEach((entry) => {
        const [importedRaw, aliasRaw] = entry.split(/\s*:\s*|\s+as\s+/).map((part) => part.trim()).filter(Boolean);
        if (!importedRaw) {
          return;
        }
        const localName = aliasRaw || importedRaw;
        bindings.push({
          localName,
          importedName: importedRaw,
          moduleSpecifier,
          kind: "named",
          line: index + 1,
          column: line.indexOf(localName) + 1,
          context: line.trim(),
        });
      });
      return;
    }

    const requireDefaultMatch = line.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(["'](.+?)["']\)/);
    if (requireDefaultMatch) {
      const [, localName, moduleSpecifier] = requireDefaultMatch;
      bindings.push({
        localName,
        importedName: "default",
        moduleSpecifier,
        kind: "default",
        line: index + 1,
        column: line.indexOf(localName) + 1,
        context: line.trim(),
      });
    }
  });

  return bindings;
}

function extractPythonImports(content: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const fromMatch = line.match(/from\s+([.\w]+)\s+import\s+(.+)/);
    if (fromMatch) {
      const [, moduleSpecifier, importList] = fromMatch;
      importList.split(",").forEach((entry) => {
        const [importedRaw, aliasRaw] = entry.split(/\s+as\s+/).map((part) => part.trim()).filter(Boolean);
        if (!importedRaw) {
          return;
        }
        const localName = aliasRaw || importedRaw;
        bindings.push({
          localName,
          importedName: importedRaw,
          moduleSpecifier,
          kind: "named",
          line: index + 1,
          column: line.indexOf(localName) + 1,
          context: line.trim(),
        });
      });
      return;
    }

    const importMatch = line.match(/import\s+([.\w]+)(?:\s+as\s+([A-Za-z_]\w*))?/);
    if (importMatch) {
      const [, moduleSpecifier, alias] = importMatch;
      const localName = alias || moduleSpecifier.split(".").at(-1) || moduleSpecifier;
      bindings.push({
        localName,
        importedName: moduleSpecifier.split(".").at(-1) || moduleSpecifier,
        moduleSpecifier,
        kind: "namespace",
        line: index + 1,
        column: line.indexOf(localName) + 1,
        context: line.trim(),
      });
    }
  });

  return bindings;
}

function collectJsCall(node: SyntaxNode, content: string, currentExecutable: CodeSymbol | null): RawCall | null {
  if (!["call_expression", "new_expression"].includes(node.type)) {
    return null;
  }

  const functionNode = node.childForFieldName("function") ?? node.childForFieldName("constructor") ?? node.firstNamedChild;
  if (!functionNode) {
    return null;
  }

  let calleeName = "";
  let qualifier: string | null = null;
  if (["identifier", "property_identifier", "type_identifier"].includes(functionNode.type)) {
    calleeName = functionNode.text;
  } else if (functionNode.type === "member_expression") {
    const objectNode = functionNode.childForFieldName("object");
    const propertyNode = functionNode.childForFieldName("property");
    if (!propertyNode) {
      return null;
    }
    calleeName = propertyNode.text;
    qualifier = objectNode?.text ?? null;
  } else {
    return null;
  }

  return {
    calleeName,
    qualifier,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    context: getLine(content, node.startPosition.row + 1).trim(),
    callerSymbolId: currentExecutable?.id ?? null,
  };
}

function collectPythonCall(node: SyntaxNode, content: string, currentExecutable: CodeSymbol | null): RawCall | null {
  if (node.type !== "call") {
    return null;
  }

  const functionNode = node.childForFieldName("function") ?? node.firstNamedChild;
  if (!functionNode) {
    return null;
  }

  let calleeName = "";
  let qualifier: string | null = null;
  if (functionNode.type === "identifier") {
    calleeName = functionNode.text;
  } else if (functionNode.type === "attribute") {
    const objectNode = functionNode.childForFieldName("object");
    const attributeNode = functionNode.childForFieldName("attribute");
    if (!attributeNode) {
      return null;
    }
    calleeName = attributeNode.text;
    qualifier = objectNode?.text ?? null;
  } else {
    return null;
  }

  return {
    calleeName,
    qualifier,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    context: getLine(content, node.startPosition.row + 1).trim(),
    callerSymbolId: currentExecutable?.id ?? null,
  };
}

function shouldSkipJsReference(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }

  if (
    [
      "function_declaration",
      "class_declaration",
      "method_definition",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "variable_declarator",
      "required_parameter",
      "optional_parameter",
      "rest_pattern",
      "import_specifier",
      "namespace_import",
      "import_clause",
      "shorthand_property_identifier_pattern",
      "pair_pattern",
    ].includes(parent.type)
  ) {
    if (fieldEquals(parent, "name", node) || fieldEquals(parent, "pattern", node) || fieldEquals(parent, "alias", node)) {
      return true;
    }
  }

  if (parent.type === "member_expression" && fieldEquals(parent, "object", node)) {
    return true;
  }

  if (parent.type === "pair" && parent.childForFieldName("key")?.id === node.id) {
    return true;
  }

  return ["this", "super"].includes(node.text);
}

function shouldSkipPythonReference(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }

  if (
    ["function_definition", "async_function_definition", "class_definition", "parameters", "typed_parameter", "default_parameter", "import_statement", "import_from_statement"].includes(parent.type)
  ) {
    if (fieldEquals(parent, "name", node)) {
      return true;
    }
  }

  if (parent.type === "attribute" && fieldEquals(parent, "object", node)) {
    return true;
  }

  return ["self", "cls"].includes(node.text);
}

function collectJsReference(
  node: SyntaxNode,
  content: string,
  currentExecutable: CodeSymbol | null,
): RawReference | null {
  if (!isIdentifierNode(node) || shouldSkipJsReference(node)) {
    return null;
  }

  const parent = node.parent;
  const qualifier = parent?.type === "member_expression" ? parent.childForFieldName("object")?.text ?? null : null;
  const role = node.type === "type_identifier" ? "type" : "usage";

  return {
    name: node.text,
    qualifier,
    role,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    context: getLine(content, node.startPosition.row + 1).trim(),
    enclosingSymbolId: currentExecutable?.id ?? null,
  };
}

function collectPythonReference(
  node: SyntaxNode,
  content: string,
  currentExecutable: CodeSymbol | null,
): RawReference | null {
  if (node.type === "attribute") {
    const attributeNode = node.childForFieldName("attribute");
    if (!attributeNode || shouldSkipPythonReference(attributeNode)) {
      return null;
    }
    return {
      name: attributeNode.text,
      qualifier: node.childForFieldName("object")?.text ?? null,
      role: "usage",
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      context: getLine(content, node.startPosition.row + 1).trim(),
      enclosingSymbolId: currentExecutable?.id ?? null,
    };
  }

  if (node.type !== "identifier" || shouldSkipPythonReference(node)) {
    return null;
  }

  return {
    name: node.text,
    qualifier: null,
    role: "usage",
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    context: getLine(content, node.startPosition.row + 1).trim(),
    enclosingSymbolId: currentExecutable?.id ?? null,
  };
}

function walkTree(
  node: SyntaxNode,
  visit: (current: SyntaxNode, ancestors: CodeSymbol[], frame: SymbolFrame) => void,
  ancestors: CodeSymbol[],
  frame: SymbolFrame,
): void {
  visit(node, ancestors, frame);
  for (const child of node.namedChildren) {
    walkTree(child, visit, ancestors, frame);
  }
}

function parseJsLike(
  parser: Parser,
  workspaceId: string,
  filePath: string,
  content: string,
  language: SupportedLanguage,
): ParsedFileData {
  const tree = parser.parse(content);
  const counts = new Map<string, number>();
  const symbols: CodeSymbol[] = [];
  const imports = extractJsImports(content);
  const references: RawReference[] = [];
  const calls: RawCall[] = [];

  function visitNode(node: SyntaxNode, ancestors: CodeSymbol[], frame: SymbolFrame): void {
    const symbol = maybeCreateJsSymbol(workspaceId, filePath, node, ancestors, counts, language);
    const nextAncestors = symbol ? [...ancestors, symbol] : ancestors;
    const nextFrame = symbol
      ? {
          symbol,
          classSymbol: symbol.kind === "class" ? symbol : frame.classSymbol,
          executableSymbol: symbol.kind === "function" || symbol.kind === "method" ? symbol : frame.executableSymbol,
        }
      : frame;

    if (symbol) {
      symbols.push(symbol);
    }

    const call = collectJsCall(node, content, frame.executableSymbol);
    if (call) {
      calls.push(call);
      references.push({
        name: call.calleeName,
        qualifier: call.qualifier,
        role: "call",
        line: call.line,
        column: call.column,
        context: call.context,
        enclosingSymbolId: call.callerSymbolId,
      });
    }

    const reference = collectJsReference(node, content, frame.executableSymbol);
    if (reference) {
      references.push(reference);
    }

    for (const child of node.namedChildren) {
      visitNode(child, nextAncestors, nextFrame);
    }
  }

  try {
    visitNode(tree.rootNode, [], { symbol: null as never, classSymbol: null, executableSymbol: null });
    return { language, symbols, imports, references, calls, parseError: tree.rootNode.hasError ? "Parser reported syntax recovery." : null };
  } finally {
    const disposableTree = tree as Parser.Tree & { delete?: () => void };
    disposableTree.delete?.();
  }
}

function parsePython(
  parser: Parser,
  workspaceId: string,
  filePath: string,
  content: string,
): ParsedFileData {
  const tree = parser.parse(content);
  const counts = new Map<string, number>();
  const symbols: CodeSymbol[] = [];
  const imports = extractPythonImports(content);
  const references: RawReference[] = [];
  const calls: RawCall[] = [];

  function visitNode(node: SyntaxNode, ancestors: CodeSymbol[], frame: SymbolFrame): void {
    const symbol = maybeCreatePythonSymbol(workspaceId, filePath, node, ancestors, counts);
    const nextAncestors = symbol ? [...ancestors, symbol] : ancestors;
    const nextFrame = symbol
      ? {
          symbol,
          classSymbol: symbol.kind === "class" ? symbol : frame.classSymbol,
          executableSymbol: symbol.kind === "function" || symbol.kind === "method" ? symbol : frame.executableSymbol,
        }
      : frame;

    if (symbol) {
      symbols.push(symbol);
    }

    const call = collectPythonCall(node, content, frame.executableSymbol);
    if (call) {
      calls.push(call);
      references.push({
        name: call.calleeName,
        qualifier: call.qualifier,
        role: "call",
        line: call.line,
        column: call.column,
        context: call.context,
        enclosingSymbolId: call.callerSymbolId,
      });
    }

    const reference = collectPythonReference(node, content, frame.executableSymbol);
    if (reference) {
      references.push(reference);
    }

    for (const child of node.namedChildren) {
      visitNode(child, nextAncestors, nextFrame);
    }
  }

  try {
    visitNode(tree.rootNode, [], { symbol: null as never, classSymbol: null, executableSymbol: null });
    return { language: "python", symbols, imports, references, calls, parseError: tree.rootNode.hasError ? "Parser reported syntax recovery." : null };
  } finally {
    const disposableTree = tree as Parser.Tree & { delete?: () => void };
    disposableTree.delete?.();
  }
}

export function parseFile(
  workspaceId: string,
  filePath: string,
  content: string,
  language: SupportedLanguage,
): ParsedFileData {
  const parser = PARSERS[language];
  if (language === "python") {
    return parsePython(parser, workspaceId, filePath, content);
  }
  return parseJsLike(parser, workspaceId, filePath, content, language);
}
