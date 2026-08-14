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
            const logger = directErrorLogger(guarded, result.name, file.current, aliases.imports);
            if (logger === undefined) continue;
            const semantic = [normal.condition, normal.normalLog, normal.suppressedEffect, normal.returned, call, logger]
              .filter((node): node is Node => node !== undefined);
            const anchor = changedAnchor(file, semantic);
            if (anchor === undefined) continue;
            signals.push({
              ruleId: "go-obs.logging.normal-cancellation-as-error",
              path: file.path,
              line: lineOf(anchor),
              message: `${normal.fn.name} classifies cancellation as normal shutdown, but ${caller.name} logs its returned error unconditionally at error level.`,
              snippet: lineText(file.current, anchor),
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
    const returned = returns.find((candidate) => exactReturnedIdentifier(candidate, source) === cancellation.errorName);
    if (returned === undefined) continue;
    const calls = descendants(consequence, "call_expression")
      .filter((call) => !insideNestedFunction(call, consequence));
    if (calls.some((call) => {
      const method = selectedMethod(call, source);
      return method !== undefined && ERROR_LOG_METHODS.has(method);
    }) || descendants(consequence, "call_expression").some((call) => calledName(call, source) === "panic")) continue;
    const normalLog = calls.find((call) => {
      const method = selectedMethod(call, source);
      return method !== undefined && NORMAL_LOG_METHODS.has(method) && isLoggingReceiver(call, source, imports) &&
        isExpressionStatement(call, consequence) &&
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
    if (!functionReceivesContext(fn, source, contextName, contextAlias)) return undefined;
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
  if (locallyDeclaredBefore(fn, errorsAlias, condition, source)) return undefined;
  const escapedErrors = escapeRegExp(errorsAlias);
  const escapedContext = escapeRegExp(contextAlias);
  const match = new RegExp(`^${escapedErrors}\\.Is\\(([A-Za-z_]\\w*),${escapedContext}\\.(?:Canceled|DeadlineExceeded)\\)$`).exec(compact);
  return match?.[1] === undefined ? undefined : { errorName: match[1] };
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

function directErrorLogger(guard: Node, errorName: string, source: string, imports: Map<string, string>): Node | undefined {
  const consequence = guard.childForFieldName("consequence");
  if (consequence === null) return undefined;
  for (const call of descendants(consequence, "call_expression")) {
    if (insideNestedFunction(call, consequence)) continue;
    const method = selectedMethod(call, source);
    if (method === undefined || !ERROR_LOG_METHODS.has(method) || !isLoggingReceiver(call, source, imports) ||
        !containsIdentifier(call, errorName, source)) continue;
    if (!isExpressionStatement(call, consequence) || !isDirectInBlock(call, consequence)) continue;
    const prefix = source.slice(consequence.startIndex, call.startIndex);
    if (/\.(?:Canceled|DeadlineExceeded)\b|\.Err\s*\(\s*\)|\.Is\s*\(/.test(prefix)) continue;
    return call;
  }
  return undefined;
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

function containsIdentifier(node: Node, name: string, source: string): boolean {
  return descendants(node, "identifier").some((candidate) => sourceText(candidate, source) === name);
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

function changedAnchor(file: SourceRevision, nodes: Node[]): Node | undefined {
  if (file.status === "repository" || file.status === "added") return nodes[nodes.length - 1];
  return nodes.find((node) => file.changedLines.has(lineOf(node)));
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function lineText(source: string, node: Node): string {
  return (source.split("\n")[lineOf(node) - 1] ?? "").trim().slice(0, 300);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
