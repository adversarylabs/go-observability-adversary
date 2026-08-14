import { descendants, parseGo, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

const ERROR_LOG_METHODS = new Set(["Error", "Errorf", "Errorw", "ErrorContext"]);
const NORMAL_LOG_METHODS = new Set(["Debug", "Debugf", "Debugw", "DebugContext", "Info", "Infof", "Infow", "InfoContext"]);
const SUPPRESSED_EFFECT_METHODS = new Set(["Ack", "Nack", "Commit", "Rollback", "Reject", "Requeue"]);
const NORMAL_WORDS = /\b(?:cancel(?:ed|led|lation)?|context done|deadline|shutdown|shutting down|stopping|skip(?:ping)?|clos(?:e|ed|ing))\b/i;

interface FunctionInfo {
  node: Node;
  body: Node;
  name: string;
  receiverName?: string;
  receiverType?: string;
}

interface CancellationReturn {
  fn: FunctionInfo;
  errorName: string;
  condition: Node;
  returned: Node;
  normalLog?: Node;
  suppressedEffect?: Node;
}

interface CancellationMatch {
  errorName: string;
  errorGuard?: Node;
}

interface StandardAliases {
  context?: string;
  errors?: string;
  imports: Map<string, string>;
}

/**
 * Find the narrow, same-file case where a helper explicitly treats context
 * cancellation as normal shutdown but a direct caller logs its returned error
 * unconditionally at error level.
 */
export async function cancellationEscalationSignals(files: SourceRevision[]): Promise<Signal[]> {
  const signals: Signal[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".go") || file.path.endsWith("_test.go")) continue;
    const tree = await parseGo(file.current);
    const previousTree = file.previous === undefined ? undefined : await parseGo(file.previous);
    try {
      if (tree.rootNode.hasError) continue;
      const aliases = standardAliases(tree.rootNode, file.current);
      if (aliases.context === undefined) continue;
      const functions = functionInfos(tree.rootNode, file.current);
      const normalReturns = functions.flatMap((fn) => normalCancellationReturns(
        fn, file.current, aliases.context!, aliases.errors, aliases.imports));
      for (const normal of normalReturns) {
        for (const caller of functions) {
          if (caller.node.id === normal.fn.node.id) continue;
          for (const call of scopedDescendants(caller, "call_expression")) {
            if (!resolvesDirectly(call, caller, normal.fn, file.current)) continue;
            const result = assignedResult(call, file.current);
            if (result === undefined) continue;
            const guarded = nonNilGuardForResult(call, caller, result.name, file.current);
            if (guarded === undefined) continue;
            const logger = directErrorLogger(guarded, call, caller, result.name, file.current, aliases);
            if (logger === undefined) continue;
            const semantic = [normal.condition, normal.normalLog, normal.suppressedEffect, normal.returned, call, logger]
              .filter((node): node is Node => node !== undefined);
            const anchor = changedAnchor(file, semantic, tree.rootNode, previousTree?.rootNode);
            if (anchor === undefined) continue;
            signals.push({
              ruleId: "go-obs.logging.normal-cancellation-as-error",
              path: file.path,
              line: anchor.line,
              message: `${normal.fn.name} classifies cancellation as normal shutdown, but ${caller.name} logs its returned error unconditionally at error level.`,
              snippet: lineText(file.current, anchor.line),
              data: {
                helper: normal.fn.name,
                caller: caller.name,
                error: result.name,
                errorLogLine: lineOf(logger),
                scope: "same-file-direct-call",
              },
            });
          }
        }
      }
    } finally {
      previousTree?.delete();
      tree.delete();
    }
  }
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.path}:${String(signal.data.errorLogLine)}:${String(signal.data.helper)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function functionInfos(root: Node, source: string): FunctionInfo[] {
  const declared: FunctionInfo[] = descendants(root, "function_declaration")
    .concat(descendants(root, "method_declaration"))
    .flatMap((node) => {
      const body = node.childForFieldName("body");
      if (body === null) return [];
      const header = sourceText(node, source).slice(0, Math.max(0, body.startIndex - node.startIndex));
      const method = /^func\s*\(\s*([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/.exec(header);
      if (method !== null) {
        return [{ node, body, name: method[3]!, receiverName: method[1]!, receiverType: method[2]! }];
      }
      const plain = /^func\s+([A-Za-z_]\w*)\s*\(/.exec(header);
      return plain === null ? [] : [{ node, body, name: plain[1]! }];
    });
  const invokedClosures = declared.flatMap((outer) =>
    descendants(outer.body, "func_literal").flatMap((node) => {
      const body = node.childForFieldName("body");
      const invocation = node.parent;
      if (body === null || invocation?.type !== "call_expression" ||
          invocation.childForFieldName("function")?.id !== node.id) return [];
      return [{
        node,
        body,
        name: `${outer.name} callback`,
        ...(outer.receiverName === undefined ? {} : { receiverName: outer.receiverName }),
        ...(outer.receiverType === undefined ? {} : { receiverType: outer.receiverType }),
      }];
    }));
  return [...declared, ...invokedClosures];
}

function standardAliases(root: Node, source: string): StandardAliases {
  const aliases: StandardAliases = { imports: new Map() };
  for (const spec of descendants(root, "import_spec")) {
    const text = sourceText(spec, source).trim();
    const match = /^(?:([A-Za-z_]\w*|[_.])\s+)?["`]([^"`]+)["`]$/.exec(text);
    if (match === null) continue;
    const path = match[2]!;
    const alias = match[1] ?? path.split("/").pop()!;
    if (alias === "_" || alias === ".") continue;
    aliases.imports.set(alias, path);
    if (path === "context") aliases.context = alias;
    else if (path === "errors") aliases.errors = alias;
  }
  return aliases;
}

function normalCancellationReturns(
  fn: FunctionInfo,
  source: string,
  contextAlias: string,
  errorsAlias: string | undefined,
  imports: Map<string, string>,
): CancellationReturn[] {
  const results: CancellationReturn[] = [];
  for (const statement of scopedDescendants(fn, "if_statement")) {
    const condition = statement.childForFieldName("condition");
    const consequence = statement.childForFieldName("consequence");
    if (condition === null || consequence === null) continue;
    const cancellation = cancellationErrorName(condition, statement, fn, source, contextAlias, errorsAlias);
    if (cancellation === undefined) continue;
    const returns = descendants(consequence, "return_statement")
      .filter((returned) => !insideNestedFunction(returned, consequence));
    const returned = returns.find((candidate) => {
      if (exactReturnedIdentifier(candidate, source) !== cancellation.errorName) return false;
      const provenanceStart = cancellation.errorGuard?.childForFieldName("condition")?.endIndex ?? condition.endIndex;
      return !bindingChangesBeforeUse(fn, cancellation.errorName, provenanceStart, candidate, source);
    });
    if (returned === undefined) continue;
    const calls = descendants(consequence, "call_expression")
      .filter((call) => !insideNestedFunction(call, consequence));
    const reachableCalls = calls.filter((call) =>
      isExpressionStatement(call, consequence) && isDirectInBlock(call, consequence) &&
      directStatementIsReachable(call, consequence, fn, source));
    if (reachableCalls.some((call) => {
      const method = selectedMethod(call, source);
      return method !== undefined && ERROR_LOG_METHODS.has(method);
    }) || reachableCalls.some((call) => calledName(call, source) === "panic" &&
      !bindingShadowsName(fn, "panic", call, source) && !packageDeclaresName(fn, "panic", source))) continue;
    const normalLog = reachableCalls.find((call) => {
      const method = selectedMethod(call, source);
      return method !== undefined && NORMAL_LOG_METHODS.has(method) && isLoggingReceiver(call, source, imports) &&
        NORMAL_WORDS.test(sourceText(call, source));
    });
    const effectScope = cancellation.errorGuard?.childForFieldName("consequence");
    const suppressedEffect = effectScope === null || effectScope === undefined ? undefined :
      descendants(effectScope, "call_expression").find((call) => {
      const method = selectedMethod(call, source);
      return call.startIndex > statement.endIndex && !insideNestedFunction(call, effectScope) &&
        method !== undefined && SUPPRESSED_EFFECT_METHODS.has(method);
    });
    if (normalLog === undefined && suppressedEffect === undefined) continue;
    results.push({
      fn,
      errorName: cancellation.errorName,
      condition,
      returned,
      ...(normalLog === undefined ? {} : { normalLog }),
      ...(suppressedEffect === undefined ? {} : { suppressedEffect }),
    });
  }
  return results;
}

function cancellationErrorName(
  condition: Node,
  statement: Node,
  fn: FunctionInfo,
  source: string,
  contextAlias: string,
  errorsAlias: string | undefined,
): CancellationMatch | undefined {
  const compact = sourceText(condition, source).replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
  const contextMatch = new RegExp(`^(?:([A-Za-z_]\\w*)\\.Err\\(\\)!=nil|nil!=([A-Za-z_]\\w*)\\.Err\\(\\))$`).exec(compact);
  if (contextMatch !== null) {
    const contextName = contextMatch[1] ?? contextMatch[2]!;
    if (!functionReceivesContext(fn, source, contextName, contextAlias) ||
        locallyShadowsParameter(fn, contextName, condition, source)) return undefined;
    let parent = statement.parent;
    while (parent !== null && parent.id !== fn.node.id) {
      if (parent.type === "if_statement") {
        const outer = parent.childForFieldName("condition");
        if (outer !== null) {
          const error = exactNonNilIdentifier(outer, source);
          if (error !== undefined) return { errorName: error, errorGuard: parent };
        }
      }
      parent = parent.parent;
    }
    return undefined;
  }
  if (errorsAlias === undefined) return undefined;
  if (bindingShadowsName(fn, errorsAlias, condition, source) ||
      bindingShadowsName(fn, contextAlias, condition, source)) return undefined;
  const escapedErrors = escapeRegExp(errorsAlias);
  const escapedContext = escapeRegExp(contextAlias);
  const atoms = splitTopLevelOr(compact).map(stripOuterParentheses);
  const expression = new RegExp(
    `^${escapedErrors}\\.Is\\(([A-Za-z_]\\w*),${escapedContext}\\.(?:Canceled|DeadlineExceeded),?\\)$`,
  );
  const names = atoms.map((candidate) => expression.exec(candidate)?.[1]);
  if (names.length === 0 || names.some((name) => name === undefined) || new Set(names).size !== 1) return undefined;
  return { errorName: names[0]! };
}

function functionReceivesContext(fn: FunctionInfo, source: string, name: string, contextAlias: string): boolean {
  const header = sourceText(fn.node, source).slice(0, Math.max(0, fn.body.startIndex - fn.node.startIndex));
  return new RegExp(`\\b${escapeRegExp(name)}\\s+${escapeRegExp(contextAlias)}\\.Context\\b`).test(header);
}

function exactNonNilIdentifier(condition: Node, source: string): string | undefined {
  const compact = sourceText(condition, source).replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
  return /^(?:([A-Za-z_]\w*)!=nil|nil!=([A-Za-z_]\w*))$/.exec(compact)?.slice(1).find(Boolean);
}

function exactReturnedIdentifier(statement: Node, source: string): string | undefined {
  const match = /^return\s+([A-Za-z_]\w*)$/.exec(sourceText(statement, source).trim());
  return match?.[1];
}

function resolvesDirectly(call: Node, caller: FunctionInfo, callee: FunctionInfo, source: string): boolean {
  const fn = call.childForFieldName("function");
  if (fn === null) return false;
  if (callee.receiverType === undefined) {
    return fn.type === "identifier" && sourceText(fn, source) === callee.name &&
      !locallyDeclaredBefore(caller, callee.name, call, source);
  }
  if (caller.receiverType !== callee.receiverType || caller.receiverName === undefined || fn.type !== "selector_expression") return false;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  return operand?.type === "identifier" && sourceText(operand, source) === caller.receiverName &&
    !locallyDeclaredBefore(caller, caller.receiverName, call, source) &&
    field !== null && sourceText(field, source) === callee.name;
}

function assignedResult(call: Node, source: string): { name: string; assignment: Node } | undefined {
  let assignment = call.parent;
  while (assignment !== null && assignment.type !== "short_var_declaration" && assignment.type !== "assignment_statement") {
    if (assignment.type === "expression_statement" || assignment.type === "if_statement") return undefined;
    assignment = assignment.parent;
  }
  if (assignment === null) return undefined;
  const right = assignment.childForFieldName("right")?.namedChildren ?? [];
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  if (right.length !== 1 || !containsNode(right[0]!, call) || left.length !== 1 || left[0]?.type !== "identifier") return undefined;
  return { name: sourceText(left[0], source), assignment };
}

function nonNilGuardForResult(call: Node, caller: FunctionInfo, name: string, source: string): Node | undefined {
  let parent = call.parent;
  while (parent !== null && parent.id !== caller.node.id) {
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      if (condition !== null && exactNonNilIdentifier(condition, source) === name) return parent;
    }
    parent = parent.parent;
  }
  return undefined;
}

function directErrorLogger(
  guard: Node,
  resultCall: Node,
  caller: FunctionInfo,
  errorName: string,
  source: string,
  aliases: StandardAliases,
): Node | undefined {
  const consequence = guard.childForFieldName("consequence");
  if (consequence === null) return undefined;
  for (const call of descendants(consequence, "call_expression")) {
    if (insideNestedFunction(call, consequence)) continue;
    const method = selectedMethod(call, source);
    if (method === undefined || !ERROR_LOG_METHODS.has(method) ||
        !errorLoggerUsesResult(call, errorName, source, aliases.imports)) continue;
    if (!isExpressionStatement(call, consequence) || !isDirectInBlock(call, consequence)) continue;
    if (!directStatementIsReachable(call, consequence, caller, source)) continue;
    if (bindingChangesBeforeUse(caller, errorName, resultCall.endIndex, call, source)) continue;
    if (callerFiltersCancellation(consequence, call, caller, errorName, source, aliases)) continue;
    return call;
  }
  return undefined;
}

function errorLoggerUsesResult(
  call: Node,
  errorName: string,
  source: string,
  imports: Map<string, string>,
): boolean {
  if (isLoggingReceiver(call, source, imports) && containsUnshadowedIdentifier(call, errorName, source)) return true;

  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return false;
  const operand = fn.childForFieldName("operand");
  if (operand?.type !== "call_expression" || selectedMethod(operand, source) !== "WithError" ||
      !isLoggingReceiver(operand, source, imports)) return false;
  return containsUnshadowedIdentifier(call, errorName, source);
}

function callerFiltersCancellation(
  block: Node,
  logger: Node,
  caller: FunctionInfo,
  errorName: string,
  source: string,
  aliases: StandardAliases,
): boolean {
  if (aliases.context === undefined || aliases.errors === undefined) return false;
  return directStatements(block).some((statement) => {
    if (statement.type !== "if_statement" || statement.endIndex >= logger.startIndex) return false;
    const condition = statement.childForFieldName("condition");
    const consequence = statement.childForFieldName("consequence");
    if (condition === null || consequence === null ||
        bindingShadowsName(caller, aliases.errors!, condition, source) ||
        bindingShadowsName(caller, aliases.context!, condition, source)) return false;
    return errorsIsCancellationName(condition, source, aliases.errors!, aliases.context!) === errorName &&
      blockTerminates(consequence, caller, source);
  });
}

function errorsIsCancellationName(
  condition: Node,
  source: string,
  errorsAlias: string,
  contextAlias: string,
): string | undefined {
  const compact = sourceText(condition, source).replace(/\s+/g, "");
  const atoms = splitTopLevelOr(compact).map(stripOuterParentheses);
  const expression = new RegExp(
    `^${escapeRegExp(errorsAlias)}\\.Is\\(([A-Za-z_]\\w*),${escapeRegExp(contextAlias)}\\.(?:Canceled|DeadlineExceeded),?\\)$`,
  );
  const names = atoms.map((candidate) => expression.exec(candidate)?.[1]);
  if (names.length === 0 || names.some((name) => name === undefined) || new Set(names).size !== 1) return undefined;
  return names[0];
}

function blockTerminates(block: Node, fn: FunctionInfo, source: string): boolean {
  for (const statement of directStatements(block)) {
    if (statementTerminates(statement, fn, source)) return true;
  }
  return false;
}

function statementTerminates(statement: Node, fn: FunctionInfo, source: string): boolean {
  if (["return_statement", "continue_statement", "break_statement", "goto_statement"].includes(statement.type)) return true;
  if (statement.type === "expression_statement") {
    const call = descendants(statement, "call_expression")[0];
    if (call !== undefined && calledName(call, source) === "panic" &&
        !bindingShadowsName(fn, "panic", call, source) && !packageDeclaresName(fn, "panic", source)) return true;
  }
  if (statement.type === "if_statement") return ifTerminates(statement, fn, source);
  return statement.type === "expression_switch_statement" && switchTerminates(statement, fn, source);
}

function directStatements(block: Node): Node[] {
  return block.namedChildren.find((child) => child.type === "statement_list")?.namedChildren ?? block.namedChildren;
}

function ifTerminates(statement: Node, fn: FunctionInfo, source: string): boolean {
  const consequence = statement.childForFieldName("consequence");
  const alternative = statement.childForFieldName("alternative");
  if (consequence === null || alternative === null || !blockTerminates(consequence, fn, source)) return false;
  return alternative.type === "if_statement" ? ifTerminates(alternative, fn, source) : blockTerminates(alternative, fn, source);
}

function switchTerminates(statement: Node, fn: FunctionInfo, source: string): boolean {
  const cases = statement.namedChildren.filter((child) =>
    child.type === "expression_case" || child.type === "default_case");
  if (cases.length === 0 || !cases.some((candidate) => candidate.type === "default_case")) return false;
  return cases.every((candidate) => caseTerminates(candidate, fn, source));
}

function caseTerminates(candidate: Node, fn: FunctionInfo, source: string): boolean {
  return directStatements(candidate).some((statement) => {
    if (["return_statement", "goto_statement"].includes(statement.type)) return true;
    if (statement.type === "expression_statement") {
      const call = descendants(statement, "call_expression")[0];
      return call !== undefined && calledName(call, source) === "panic" &&
        !bindingShadowsName(fn, "panic", call, source) && !packageDeclaresName(fn, "panic", source);
    }
    if (statement.type === "if_statement") return ifTerminates(statement, fn, source);
    return statement.type === "expression_switch_statement" && switchTerminates(statement, fn, source);
  });
}

function directStatementIsReachable(node: Node, block: Node, fn: FunctionInfo, source: string): boolean {
  const statements = directStatements(block);
  const containing = statements.find((statement) => containsNode(statement, node));
  if (containing === undefined) return false;
  return !statements.some((statement) => {
    if (statement.endIndex > containing.startIndex) return false;
    if (statement.type === "goto_statement") return gotoBypassesNode(statement, node, fn, source);
    return statementTerminates(statement, fn, source);
  });
}

function gotoBypassesNode(statement: Node, node: Node, fn: FunctionInfo, source: string): boolean {
  const label = /\bgoto\s+([A-Za-z_]\w*)/.exec(sourceText(statement, source))?.[1];
  if (label === undefined) return true;
  const target = scopedDescendants(fn, "labeled_statement").find((candidate) =>
    new RegExp(`^\\s*${escapeRegExp(label)}\\s*:`).test(sourceText(candidate, source)));
  return target === undefined || target.startIndex < statement.startIndex || target.startIndex > node.endIndex;
}

function isLoggingReceiver(call: Node, source: string, imports: Map<string, string>): boolean {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return false;
  const operand = fn.childForFieldName("operand");
  if (operand === null) return false;
  const receiver = sourceText(operand, source);
  if (operand.type !== "identifier") return /(?:^|\.)(?:log|logger|logging|slog|zap|zerolog)$/i.test(receiver);
  const path = imports.get(receiver);
  if (path !== undefined) {
    return path === "log/slog" || /(?:^|\/)(?:log|logging|logrus|zap|zerolog|glog)(?:\/|$)/i.test(path);
  }
  return /^(?:log|logger|logging|slog|zap|zerolog)$/i.test(receiver);
}

function isDirectInBlock(node: Node, block: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== block.id) {
    if (["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "select_statement", "func_literal"].includes(current.type)) return false;
    current = current.parent;
  }
  return current?.id === block.id;
}

function isExpressionStatement(node: Node, block: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== block.id) {
    if (current.type === "expression_statement") return true;
    if (["return_statement", "assignment_statement", "short_var_declaration", "defer_statement", "go_statement"].includes(current.type)) return false;
    current = current.parent;
  }
  return false;
}

function locallyDeclaredBefore(fn: FunctionInfo, name: string, use: Node, source: string): boolean {
  const header = sourceText(fn.node, source).slice(0, Math.max(0, fn.body.startIndex - fn.node.startIndex));
  if (new RegExp(`[(,]\\s*${escapeRegExp(name)}\\s+`).test(header) && name !== fn.receiverName) return true;
  const prefix = source.slice(fn.body.startIndex, use.startIndex);
  return new RegExp(`(?:\\bvar\\s+${escapeRegExp(name)}\\b|\\b${escapeRegExp(name)}\\s*:=)`).test(prefix);
}

function bindingShadowsName(fn: FunctionInfo, name: string, use: Node, source: string): boolean {
  return fn.receiverName === name || locallyDeclaredBefore(fn, name, use, source);
}

function locallyShadowsParameter(fn: FunctionInfo, name: string, use: Node, source: string): boolean {
  for (const declaration of scopedDescendants(fn, "short_var_declaration")) {
    if (declaration.endIndex >= use.startIndex) continue;
    const left = declaration.childForFieldName("left");
    const scope = enclosingBlock(declaration);
    if (left !== null && directlyAssignsIdentifier(left, name, source) &&
        scope !== null && ((scope.id !== fn.body.id && containsNode(scope, use)) ||
          controlInitializerScopesUse(declaration, use, scope))) return true;
  }
  for (const declaration of scopedDescendants(fn, "var_declaration")) {
    if (declaration.endIndex >= use.startIndex) continue;
    const scope = enclosingBlock(declaration);
    if (scope === null || scope.id === fn.body.id || !containsNode(scope, use)) continue;
    if (new RegExp(`^\\s*var\\s+(?:\\([^)]*\\b)?${escapeRegExp(name)}\\b`, "s")
      .test(sourceText(declaration, source))) return true;
  }
  return false;
}

function controlInitializerScopesUse(declaration: Node, use: Node, enclosing: Node): boolean {
  let current = declaration.parent;
  while (current !== null && current.id !== enclosing.id) {
    if (["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement"].includes(current.type)) {
      return containsNode(current, use);
    }
    current = current.parent;
  }
  return false;
}

function packageDeclaresName(fn: FunctionInfo, name: string, source: string): boolean {
  let root = fn.node;
  while (root.parent !== null) root = root.parent;
  return root.namedChildren.some((declaration) => {
    if (declaration.type === "function_declaration") {
      const declared = declaration.childForFieldName("name");
      return declared !== null && sourceText(declared, source) === name;
    }
    if (declaration.type === "type_declaration") {
      return descendants(declaration, "type_spec").some((spec) =>
        sourceText(spec, source).trimStart().startsWith(`${name} `));
    }
    if (declaration.type !== "var_declaration" && declaration.type !== "const_declaration") return false;
    return new RegExp(`^(?:var|const)\\s+(?:${escapeRegExp(name)}\\b|\\([\\s\\S]*?^\\s*${escapeRegExp(name)}\\b)`, "m")
      .test(sourceText(declaration, source));
  });
}

function selectedMethod(call: Node, source: string): string | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return undefined;
  const field = fn.childForFieldName("field");
  return field === null ? undefined : sourceText(field, source);
}

function calledName(call: Node, source: string): string | undefined {
  const fn = call.childForFieldName("function");
  return fn?.type === "identifier" ? sourceText(fn, source) : undefined;
}

function containsUnshadowedIdentifier(node: Node, name: string, source: string): boolean {
  return descendants(node, "identifier").some((candidate) =>
    sourceText(candidate, source) === name && !insideNestedFunction(candidate, node) &&
    !isCompositeLiteralKey(candidate)
  );
}

function isCompositeLiteralKey(node: Node): boolean {
  const literal = node.parent;
  const keyed = literal?.parent;
  if (literal?.type !== "literal_element" || keyed?.type !== "keyed_element" ||
      keyed.namedChildren[0]?.id !== literal.id) return false;
  const values = keyed.parent;
  const composite = values?.parent;
  return values?.type === "literal_value" && composite?.type === "composite_literal" &&
    composite.namedChildren[0]?.type === "struct_type";
}

function bindingChangesBeforeUse(
  fn: FunctionInfo,
  name: string,
  startIndex: number,
  use: Node,
  source: string,
): boolean {
  for (const assignment of descendants(fn.body, "assignment_statement")) {
    if (assignment.startIndex <= startIndex || assignment.endIndex >= use.startIndex) continue;
    if (insideNestedFunction(assignment, fn.body) &&
        !immediatelyInvokedMutation(assignment, fn, name, source)) continue;
    const left = assignment.childForFieldName("left");
    if (left !== null && directlyAssignsIdentifier(left, name, source)) return true;
  }
  for (const declaration of scopedDescendants(fn, "short_var_declaration")) {
    if (declaration.startIndex <= startIndex || declaration.endIndex >= use.startIndex) continue;
    const left = declaration.childForFieldName("left");
    if (left === null || !directlyAssignsIdentifier(left, name, source)) continue;
    const scope = enclosingBlock(declaration);
    if (scope !== null && containsNode(scope, use)) return true;
  }
  for (const declaration of scopedDescendants(fn, "var_declaration")) {
    if (declaration.startIndex <= startIndex || declaration.endIndex >= use.startIndex) continue;
    if (!new RegExp(`^\\s*var\\s+(?:\\([^)]*\\b)?${escapeRegExp(name)}\\b`, "s")
      .test(sourceText(declaration, source))) continue;
    const scope = enclosingBlock(declaration);
    if (scope !== null && containsNode(scope, use)) return true;
  }
  return false;
}

function immediatelyInvokedMutation(
  mutation: Node,
  fn: FunctionInfo,
  name: string,
  source: string,
): boolean {
  let literal = mutation.parent;
  while (literal !== null && literal.id !== fn.body.id && literal.type !== "func_literal") literal = literal.parent;
  if (literal === null || literal.type !== "func_literal") return false;
  const body = literal.childForFieldName("body");
  if (body === null) return false;

  let invocation = literal.parent;
  while (invocation !== null && invocation.type === "parenthesized_expression") invocation = invocation.parent;
  if (invocation?.type !== "call_expression" ||
      !containsNode(invocation.childForFieldName("function") ?? invocation, literal) ||
      insideNestedFunction(invocation, fn.body)) return false;

  const header = sourceText(literal, source).slice(0, Math.max(0, body.startIndex - literal.startIndex));
  if (new RegExp(`[(,]\\s*${escapeRegExp(name)}\\s+`).test(header)) return false;
  const prefix = source.slice(body.startIndex, mutation.startIndex);
  return !new RegExp(`(?:\\bvar\\s+${escapeRegExp(name)}\\b|\\b${escapeRegExp(name)}\\s*:=)`).test(prefix);
}

function directlyAssignsIdentifier(node: Node, name: string, source: string): boolean {
  if (node.type === "identifier" && sourceText(node, source) === name) return true;
  if (node.type !== "expression_list") return false;
  return node.namedChildren.some((candidate) =>
    candidate.type === "identifier" && sourceText(candidate, source) === name
  );
}

function enclosingBlock(node: Node): Node | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "block") return current;
    current = current.parent;
  }
  return null;
}

function containsNode(ancestor: Node, node: Node): boolean {
  return node.startIndex >= ancestor.startIndex && node.endIndex <= ancestor.endIndex;
}

function scopedDescendants(fn: FunctionInfo, type: string): Node[] {
  return descendants(fn.body, type).filter((node) => !insideNestedFunction(node, fn.body));
}

function insideNestedFunction(node: Node, boundary: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== boundary.id) {
    if (current.type === "func_literal") return true;
    current = current.parent;
  }
  return false;
}

function changedAnchor(
  file: SourceRevision,
  nodes: Node[],
  currentRoot: Node,
  previousRoot?: Node,
): { node: Node; line: number } | undefined {
  if (file.status === "repository" || file.status === "added") {
    const node = nodes[nodes.length - 1];
    return node === undefined ? undefined : { node, line: lineOf(node) };
  }
  for (const node of nodes) {
    if (previousRoot !== undefined && !semanticNodeChanged(node, currentRoot, previousRoot, file.current, file.previous!)) continue;
    for (let line = lineOf(node); line <= node.endPosition.row + 1; line += 1) {
      if (file.changedLines.has(line) && hasSemanticLeafOnLine(node, line) &&
          (previousRoot !== undefined || !hasCommentOnLine(currentRoot, line))) return { node, line };
    }
  }
  return undefined;
}

function semanticNodeChanged(node: Node, currentRoot: Node, previousRoot: Node, current: string, previous: string): boolean {
  const signature = semanticText(node, current);
  const currentCount = descendants(currentRoot, node.type).filter((candidate) => semanticText(candidate, current) === signature).length;
  const previousCount = descendants(previousRoot, node.type).filter((candidate) => semanticText(candidate, previous) === signature).length;
  return currentCount > previousCount;
}

function semanticText(node: Node, source: string): string {
  if (node.type === "comment") return "";
  if (node.childCount === 0) return sourceText(node, source).replace(/\s+/g, "");
  return node.children.map((child) => semanticText(child, source)).join("");
}

function hasCommentOnLine(node: Node, line: number): boolean {
  return descendants(node, "comment").some((comment) =>
    line >= lineOf(comment) && line <= comment.endPosition.row + 1);
}

function hasSemanticLeafOnLine(node: Node, line: number): boolean {
  if (node.type === "comment" || line < lineOf(node) || line > node.endPosition.row + 1) return false;
  const children = node.namedChildren.filter((child) =>
    child.type !== "comment" && line >= lineOf(child) && line <= child.endPosition.row + 1
  );
  if (children.length === 0) return node.namedChildCount === 0;
  return children.some((child) => hasSemanticLeafOnLine(child, line));
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function lineText(source: string, line: number): string {
  return (source.split("\n")[line - 1] ?? "").trim().slice(0, 300);
}

function splitTopLevelOr(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") depth -= 1;
    else if (depth === 0 && value[index] === "|" && value[index + 1] === "|") {
      parts.push(value.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  parts.push(value.slice(start));
  return parts.filter((part) => part.length > 0);
}

function stripOuterParentheses(value: string): string {
  let current = value;
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let enclosesAll = true;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "(") depth += 1;
      else if (current[index] === ")") depth -= 1;
      if (depth === 0 && index < current.length - 1) { enclosesAll = false; break; }
    }
    if (!enclosesAll) break;
    current = current.slice(1, -1);
  }
  return current;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
