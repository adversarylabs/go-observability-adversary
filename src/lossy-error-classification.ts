import { descendants, parseGo, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

const PARSER_METHOD = /^(?:Parse\w*|Decode\w*|Unmarshal\w*|\w*From(?:Manifest|Blob|JSON|YAML|XML))$/;
const ERROR_NAME = /^(?:err|\w*(?:Err|Error))$/;
const CLASSIFICATION_COMMENT = /\b(?:assum(?:e|ing)|treat(?:ed|ing)?|classif(?:y|ied|ication)|fallback|conservativ(?:e|ely)|unable to parse|expected to fail|not an?\b)\b/i;
const LOG_METHOD = /^(?:Debug|Debugf|Debugw|DebugContext|Info|Infof|Infow|InfoContext|Warn|Warnf|Warnw|WarnContext|Error|Errorf|Errorw|ErrorContext)$/;

interface Imports {
  aliases: Map<string, string>;
  context?: string;
  errors?: string;
}

interface FunctionInfo {
  node: Node;
  body: Node;
  name: string;
  contextName?: string;
}

interface Candidate {
  signature: string;
  fn: FunctionInfo;
  assignment: Node;
  guard: Node;
  returned: Node;
  parserPackage: string;
  parserMethod: string;
  errorName: string;
  sentinel: string;
  comment: string;
  loggerPackage: string;
}

/**
 * Detect the deliberately narrow case where changed code maps an external
 * parser failure to a package sentinel, explicitly describes the branch as a
 * fallback/classification, and discards the only diagnostic cause even though
 * this file already has a context-aware project logger available.
 */
export async function lossyErrorClassificationSignals(files: SourceRevision[]): Promise<Signal[]> {
  const signals: Signal[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".go") || file.path.endsWith("_test.go")) continue;
    const currentTree = await parseGo(file.current);
    const previousTree = file.previous === undefined ? undefined : await parseGo(file.previous);
    try {
      if (currentTree.rootNode.hasError || previousTree?.rootNode.hasError === true) continue;
      const current = candidates(currentTree.rootNode, file.current);
      const previousCounts = signatureCounts(
        previousTree === undefined ? [] : candidates(previousTree.rootNode, file.previous!),
      );
      const currentCounts = new Map<string, number>();
      for (const item of current) {
        const occurrence = (currentCounts.get(item.signature) ?? 0) + 1;
        currentCounts.set(item.signature, occurrence);
        if (file.status === "modified" && occurrence <= (previousCounts.get(item.signature) ?? 0)) continue;
        const anchor = changedAnchor(file, [item.assignment, item.guard, item.returned]);
        if (anchor === undefined) continue;
        signals.push({
          ruleId: "go-obs.logging.lossy-parse-classification",
          path: file.path,
          line: anchor,
          message: `${item.fn.name} classifies ${item.parserPackage}.${item.parserMethod} failures as ${item.sentinel} but discards the parser error without diagnostics.`,
          snippet: lineText(file.current, anchor),
          data: {
            function: item.fn.name,
            parser: `${item.parserPackage}.${item.parserMethod}`,
            discardedError: item.errorName,
            returnedSentinel: item.sentinel,
            logger: item.loggerPackage,
            classification: item.comment,
            scope: "same-function-immediate-parser-classification",
          },
        });
      }
    } finally {
      previousTree?.delete();
      currentTree.delete();
    }
  }
  return signals;
}

function signatureCounts(items: Candidate[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) result.set(item.signature, (result.get(item.signature) ?? 0) + 1);
  return result;
}

function candidates(root: Node, source: string): Candidate[] {
  const imports = importedAliases(root, source);
  if (imports.context === undefined || imports.errors === undefined) return [];
  const functions = functionInfos(root, source, imports.context);
  const sentinels = packageErrorSentinels(root, source, imports.errors);
  if (sentinels.size === 0) return [];
  const loggers = contextLoggerPackages(functions, source, imports);
  if (loggers.size === 0) return [];

  const result: Candidate[] = [];
  for (const fn of functions) {
    if (fn.contextName === undefined) continue;
    const blocks = descendants(fn.body, "block").filter((block) =>
      block.id === fn.body.id || !insideNestedFunction(block, fn.body));
    for (const block of blocks) {
      const statements = directStatements(block);
      for (let index = 0; index < statements.length - 1; index += 1) {
        const assignment = statements[index]!;
        if (assignment.type !== "short_var_declaration" && assignment.type !== "assignment_statement") continue;
        if (!isReachable(assignment, fn, source) ||
            localBindingDeclaredBefore(fn, fn.contextName!, assignment.startIndex, source)) continue;
        const parsed = parserAssignment(assignment, source, imports, fn);
        if (parsed === undefined) continue;
        const guard = statements[index + 1]!;
        if (guard.type !== "if_statement" || !isNonNilGuard(guard, parsed.errorName, source)) continue;
        const consequence = guard.childForFieldName("consequence");
        if (consequence === null) continue;
        const branch = directStatements(consequence);
        const returned = branch.find((node) => node.type === "return_statement");
        if (returned === undefined || branch.length !== 1) continue;
        const sentinel = returnedIdentifier(returned, source);
        if (sentinel === undefined || !sentinels.has(sentinel)) continue;
        const comment = classificationComment(source.slice(assignment.endIndex, guard.startIndex));
        if (comment === undefined) continue;
        const loggerPackage = [...loggers].find((alias) =>
          !bindingDeclaredBefore(fn, alias, assignment.startIndex, source));
        if (loggerPackage === undefined) continue;
        result.push({
          signature: [fn.name, parsed.parserPackage, parsed.parserMethod, parsed.errorName, sentinel].join("|"),
          fn,
          assignment,
          guard,
          returned,
          parserPackage: parsed.parserPackage,
          parserMethod: parsed.parserMethod,
          errorName: parsed.errorName,
          sentinel,
          comment,
          loggerPackage,
        });
      }
    }
  }
  return result;
}

function importedAliases(root: Node, source: string): Imports {
  const aliases = new Map<string, string>();
  const result: Imports = { aliases };
  for (const spec of descendants(root, "import_spec")) {
    const match = /^(?:([A-Za-z_]\w*|[_.])\s+)?["`]([^"`]+)["`]$/.exec(sourceText(spec, source).trim());
    if (match === null) continue;
    const path = match[2]!;
    const alias = match[1] ?? path.split("/").pop()!;
    if (alias === "_" || alias === ".") continue;
    aliases.set(alias, path);
    if (path === "context") result.context = alias;
    if (path === "errors") result.errors = alias;
  }
  return result;
}

function functionInfos(root: Node, source: string, contextAlias: string): FunctionInfo[] {
  return descendants(root, "function_declaration")
    .concat(descendants(root, "method_declaration"))
    .flatMap((node) => {
      const body = node.childForFieldName("body");
      if (body === null) return [];
      const header = sourceText(node, source).slice(0, body.startIndex - node.startIndex);
      const method = /^func\s*\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/.exec(header);
      const plain = /^func\s+([A-Za-z_]\w*)\s*\(/.exec(header);
      const name = method?.[1] ?? plain?.[1];
      if (name === undefined) return [];
      const contextMatch = new RegExp(`\\b([A-Za-z_]\\w*)\\s+${escapeRegExp(contextAlias)}\\.Context\\b`).exec(header);
      return [{ node, body, name, ...(contextMatch === null ? {} : { contextName: contextMatch[1]! }) }];
    });
}

function packageErrorSentinels(root: Node, source: string, errorsAlias: string): Set<string> {
  const result = new Set<string>();
  for (const declaration of root.namedChildren.filter((node) => node.type === "var_declaration")) {
    for (const spec of declaration.namedChildren.filter((node) => node.type === "var_spec")) {
      const match = new RegExp(
        `^\\s*([A-Za-z_]\\w*)\\s*=\\s*${escapeRegExp(errorsAlias)}\\.New\\s*\\(`,
      ).exec(sourceText(spec, source));
      if (match !== null) result.add(match[1]!);
    }
  }
  return result;
}

function contextLoggerPackages(functions: FunctionInfo[], source: string, imports: Imports): Set<string> {
  const result = new Set<string>();
  for (const fn of functions) {
    if (fn.contextName === undefined) continue;
    for (const call of descendants(fn.body, "call_expression")) {
      if (insideNestedFunction(call, fn.body)) continue;
      if (!isReachable(call, fn, source)) continue;
      const selected = selectedCall(call, source);
      if (selected === undefined || !LOG_METHOD.test(selected.method)) continue;
      const path = imports.aliases.get(selected.receiver);
      if (path === undefined || !/(?:^|\/)(?:log|logging|logrus|zap)(?:\/|$)/i.test(path)) continue;
      if (bindingDeclaredBefore(fn, selected.receiver, call.startIndex, source)) continue;
      const args = call.childForFieldName("arguments");
      if (args === null) continue;
      const first = args.namedChild(0);
      if (first !== null && sourceText(first, source).trim() === fn.contextName) result.add(selected.receiver);
    }
  }
  return result;
}

function parserAssignment(
  statement: Node,
  source: string,
  imports: Imports,
  fn: FunctionInfo,
): { parserPackage: string; parserMethod: string; errorName: string } | undefined {
  const left = statement.namedChild(0);
  const right = statement.namedChild(1);
  if (left === null || right === null || left.type !== "expression_list" || right.type !== "expression_list") return undefined;
  if (left.namedChildCount !== 2 || right.namedChildCount !== 1) return undefined;
  const errorNode = left.namedChild(1);
  const call = right.namedChild(0);
  if (errorNode === null || call === null || errorNode.type !== "identifier" || call.type !== "call_expression") return undefined;
  const errorName = sourceText(errorNode, source);
  if (!ERROR_NAME.test(errorName)) return undefined;
  const selected = selectedCall(call, source);
  if (selected === undefined || !PARSER_METHOD.test(selected.method)) return undefined;
  if (!imports.aliases.has(selected.receiver) || bindingDeclaredBefore(fn, selected.receiver, call.startIndex, source)) return undefined;
  return { parserPackage: selected.receiver, parserMethod: selected.method, errorName };
}

function selectedCall(call: Node, source: string): { receiver: string; method: string } | undefined {
  const fn = call.childForFieldName("function");
  if (fn === null || fn.type !== "selector_expression") return undefined;
  const match = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(sourceText(fn, source).replace(/\s+/g, ""));
  return match === null ? undefined : { receiver: match[1]!, method: match[2]! };
}

function isNonNilGuard(statement: Node, errorName: string, source: string): boolean {
  const condition = statement.childForFieldName("condition");
  if (condition === null) return false;
  const compact = sourceText(condition, source).replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
  return compact === `${errorName}!=nil` || compact === `nil!=${errorName}`;
}

function returnedIdentifier(statement: Node, source: string): string | undefined {
  const values = statement.namedChild(0);
  if (values === null || values.type !== "expression_list" || values.namedChildCount !== 1) return undefined;
  const value = values.namedChild(0);
  return value?.type === "identifier" ? sourceText(value, source) : undefined;
}

function directStatements(block: Node): Node[] {
  const list = block.namedChildren.find((node) => node.type === "statement_list");
  return list?.namedChildren.filter((node) => node.type !== "comment") ?? [];
}

function classificationComment(gap: string): string | undefined {
  const comments = gap.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
  const match = comments.find((comment) => CLASSIFICATION_COMMENT.test(comment));
  return match?.replace(/^\/[/\*]\s*|\s*\*\/$/g, "").trim().slice(0, 240);
}

function bindingDeclaredBefore(fn: FunctionInfo, name: string, before: number, source: string): boolean {
  const header = sourceText(fn.node, source).slice(0, fn.body.startIndex - fn.node.startIndex);
  if (new RegExp(`(?:^|[,;(])\\s*${escapeRegExp(name)}\\s+(?:\\*?[A-Za-z_]|interface\\b|func\\b)`).test(header)) return true;
  const prefix = source.slice(fn.body.startIndex, before);
  return new RegExp(`(?:^|[;{}\\n])\\s*(?:var\\s+)?${escapeRegExp(name)}\\s*(?::=|=)`, "m").test(prefix);
}

function localBindingDeclaredBefore(fn: FunctionInfo, name: string, before: number, source: string): boolean {
  const prefix = source.slice(fn.body.startIndex, before);
  return new RegExp(`(?:^|[;{}\\n])\\s*(?:var\\s+)?${escapeRegExp(name)}\\s*(?::=|=)`, "m").test(prefix);
}

function insideNestedFunction(node: Node, boundary: Node): boolean {
  let parent = node.parent;
  while (parent !== null && parent.id !== boundary.id) {
    if (parent.type === "func_literal" || parent.type === "function_declaration" || parent.type === "method_declaration") return true;
    parent = parent.parent;
  }
  return false;
}

function isReachable(node: Node, fn: FunctionInfo, source: string): boolean {
  let current: Node | null = node;
  while (current !== null && current.id !== fn.body.id) {
    const parent: Node | null = current.parent;
    if (parent === null) return false;
    if (parent.type === "statement_list") {
      const direct: Node[] = parent.namedChildren.filter((child: Node) => child.type !== "comment");
      const index = direct.findIndex((child) => child.id === current!.id);
      if (index >= 0 && direct.slice(0, index).some((prior) => definitelyTerminates(prior, fn, source))) return false;
    }
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const alternative = parent.childForFieldName("alternative");
      const value = condition === null ? undefined : staticBoolean(condition, source);
      if ((current.id === consequence?.id && value === false) ||
          (current.id === alternative?.id && value === true)) return false;
    }
    current = parent;
  }
  return current?.id === fn.body.id;
}

function staticBoolean(node: Node, source: string): boolean | undefined {
  let text = sourceText(node, source).replace(/\s+/g, "");
  while (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function definitelyTerminates(statement: Node, fn: FunctionInfo, source: string): boolean {
  if (statement.type === "return_statement") return true;
  if (statement.type !== "expression_statement") return false;
  const expression = statement.namedChild(0);
  if (expression?.type !== "call_expression") return false;
  const callee = expression.childForFieldName("function");
  if (callee === null || callee.type !== "identifier" || sourceText(callee, source) !== "panic") return false;
  return !lexicallyDeclaredBefore(fn, "panic", expression, source) &&
    !packageDeclaresName(fn.node, "panic", source);
}

function lexicallyDeclaredBefore(fn: FunctionInfo, name: string, use: Node, source: string): boolean {
  const header = sourceText(fn.node, source).slice(0, fn.body.startIndex - fn.node.startIndex);
  if (new RegExp(`(?:^|[,;(])\\s*${escapeRegExp(name)}\\s+(?:\\*?[A-Za-z_]|interface\\b|func\\b)`).test(header)) return true;
  let current: Node | null = use;
  while (current !== null && current.id !== fn.body.id) {
    const parent: Node | null = current.parent;
    if (parent === null) return false;
    if (parent.type === "statement_list") {
      const direct: Node[] = parent.namedChildren.filter((child: Node) => child.type !== "comment");
      const index = direct.findIndex((child) => child.id === current!.id);
      if (index >= 0 && direct.slice(0, index).some((prior) => declaresName(prior, name, source))) return true;
    } else if (current.type === "block") {
      const preceding = parent.namedChildren.slice(0, parent.namedChildren.findIndex((child) => child.id === current!.id));
      if (preceding.some((candidate) => declaresName(candidate, name, source))) return true;
    }
    current = parent;
  }
  return false;
}

function declaresName(node: Node, name: string, source: string): boolean {
  if (node.type === "short_var_declaration") {
    const left = node.namedChild(0);
    return left?.type === "expression_list" && left.namedChildren.some((child) =>
      child.type === "identifier" && sourceText(child, source) === name);
  }
  if (node.type === "var_declaration" || node.type === "const_declaration") {
    return node.namedChildren.some((spec) => spec.namedChildren.some((child) =>
      child.type === "identifier" && sourceText(child, source) === name));
  }
  if (node.type === "range_clause" || node.type === "receive_statement") {
    const declaration = sourceText(node, source).split(":=", 1)[0];
    return sourceText(node, source).includes(":=") &&
      new RegExp(`(?:^|,)\\s*${escapeRegExp(name)}\\s*(?:,|$)`).test(declaration ?? "");
  }
  return false;
}

function packageDeclaresName(node: Node, name: string, source: string): boolean {
  let root = node;
  while (root.parent !== null) root = root.parent;
  return root.namedChildren.some((child) => {
    if (child.type === "function_declaration") {
      return new RegExp(`^func\\s+${escapeRegExp(name)}\\s*\\(`).test(sourceText(child, source));
    }
    if (child.type === "var_declaration" || child.type === "const_declaration") {
      return declaresName(child, name, source);
    }
    if (child.type === "type_declaration") {
      return new RegExp(`^type\\s+${escapeRegExp(name)}\\b`).test(sourceText(child, source));
    }
    return false;
  });
}

function changedAnchor(file: SourceRevision, nodes: Node[]): number | undefined {
  if (file.status === "repository" || file.status === "added") return lineOf(nodes[0]!);
  for (const node of nodes) {
    for (let line = lineOf(node); line <= node.endPosition.row + 1; line += 1) {
      if (file.changedLines.has(line)) return line;
    }
  }
  return undefined;
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function lineText(source: string, line: number): string {
  return source.split("\n")[line - 1]?.trim().slice(0, 300) ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
