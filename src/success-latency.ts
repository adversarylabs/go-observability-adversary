import { descendants, parseGo, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

const DURATION_METHOD = /^(?:ExponentialHistogram|Histogram|Observe|ObserveDuration|Record|RecordDuration)$/;
const NON_SUCCESS_PATH = /\b(?:skip(?:ped)?|buffer(?:ed)?|already|duplicate|exists?|no[_ -]?op|ignored?|filtered?|cached|not[_ -]?(?:start|run))\b/i;
const SUCCESS_CONTRACT = /\b(?:success(?:ful(?:ly)?)?|succeed(?:ed)?|completion|completed|started)\b/i;
const OUTCOME_DIMENSION = /\b(?:Outcome|Result|Status|Success|Error|Failure|Failed|Skipped)\w*Tag\s*\(/;

interface MetricContract {
  identifier: string;
  operation: string;
  text: string;
  path: string;
  directory: string;
  packageName: string;
}

interface Candidate {
  signature: string;
  functionName: string;
  metric: string;
  operation: string;
  deferNode: Node;
  metricCall: Node;
  completionCall: Node;
  earlyReturn: Node;
}

/**
 * Find a success-only latency distribution emitted from a defer that also
 * covers a proven skipped/non-success return before the named completion
 * operation. The metric's success contract must be present in prepared source.
 */
export async function successLatencyOnNonSuccessPathSignals(files: SourceRevision[]): Promise<Signal[]> {
  const contracts = metricContracts(files);
  if (contracts.length === 0) return [];

  const signals: Signal[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".go") || file.path.endsWith("_test.go")) continue;
    const currentTree = await parseGo(file.current);
    const previousTree = file.previous === undefined ? undefined : await parseGo(file.previous);
    try {
      if (currentTree.rootNode.hasError || previousTree?.rootNode.hasError === true) continue;
      const current = candidates(currentTree.rootNode, file.current, contracts, file.path);
      const previousCounts = signatureCounts(
        previousTree === undefined ? [] : candidates(previousTree.rootNode, file.previous!, contracts, file.path),
      );
      const currentCounts = new Map<string, number>();
      for (const candidate of current) {
        const occurrence = (currentCounts.get(candidate.signature) ?? 0) + 1;
        currentCounts.set(candidate.signature, occurrence);
        if (file.status === "modified" && occurrence <= (previousCounts.get(candidate.signature) ?? 0)) continue;
        const anchor = changedAnchor(file, [
          candidate.deferNode,
          candidate.metricCall,
          candidate.earlyReturn,
          candidate.completionCall,
        ]);
        if (anchor === undefined) continue;
        signals.push({
          ruleId: "go-obs.metrics.success-latency-on-non-success-paths",
          path: file.path,
          line: anchor,
          message: `${candidate.functionName} defers ${candidate.metric} before a skipped return, so the success-latency distribution includes work that never reaches ${candidate.operation}.`,
          snippet: lineText(file.current, anchor),
          data: {
            function: candidate.functionName,
            metric: candidate.metric,
            completionOperation: candidate.operation,
            scope: "same-function-deferred-success-latency",
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

function metricContracts(files: SourceRevision[]): MetricContract[] {
  const contracts: MetricContract[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".go") || file.path.endsWith("_test.go")) continue;
    const packageName = /^\s*package\s+([A-Za-z_]\w*)\b/m.exec(file.current)?.[1];
    if (packageName === undefined) continue;
    for (const match of file.current.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
      const text = match[0];
      if (!SUCCESS_CONTRACT.test(text)) continue;
      const identifier = /\b([A-Z][A-Za-z0-9_]*(?:Latency|Duration)[A-Za-z0-9_]*)\b/.exec(text)?.[1];
      const operation = /\b([A-Z][A-Za-z0-9]{2,})\s+(?:completion|completed)\b/.exec(text)?.[1];
      if (identifier === undefined || operation === undefined) continue;
      contracts.push({
        identifier,
        operation,
        text: normalize(text),
        path: file.path,
        directory: directory(file.path),
        packageName,
      });
    }
  }
  return contracts;
}

function candidates(root: Node, source: string, contracts: MetricContract[], path = ""): Candidate[] {
  const result: Candidate[] = [];
  const imports = importAliases(root, source);
  const packageName = /^\s*package\s+([A-Za-z_]\w*)\b/m.exec(source)?.[1] ?? "";
  const functions = descendants(root, "function_declaration").concat(descendants(root, "method_declaration"));
  for (const fn of functions) {
    const body = fn.childForFieldName("body");
    const nameNode = fn.childForFieldName("name");
    if (body === null || nameNode === null) continue;
    const functionName = sourceText(nameNode, source);
    for (const deferNode of descendants(body, "defer_statement")) {
      if (owningFunction(deferNode)?.id !== fn.id || staticallyDead(deferNode, source)) continue;
      const literal = descendants(deferNode, "func_literal")[0];
      if (literal === undefined) continue;
      const literalBody = literal.childForFieldName("body");
      if (literalBody === null) continue;
      for (const metricCall of descendants(literalBody, "call_expression")) {
        if (owningFunction(metricCall)?.id !== literal.id) continue;
        const method = selectedMethod(metricCall, source);
        if (method === undefined || !DURATION_METHOD.test(method)) continue;
        const callText = sourceText(metricCall, source);
        if (!/\btime\.Since\s*\(|\.Seconds\s*\(|\.Milliseconds\s*\(/.test(callText)) continue;
        const matchingContracts = contracts.filter((item) => contractMatchesCall(
          item,
          callText,
          imports,
          packageName,
          directory(path),
        ));
        if (matchingContracts.length !== 1) continue;
        const contract = matchingContracts[0]!;
        if (successGuarded(metricCall, literalBody, source)) continue;
        if (OUTCOME_DIMENSION.test(sourceText(literalBody, source))) continue;

        const completionCall = descendants(body, "call_expression")
          .filter((call) => owningFunction(call)?.id === fn.id && call.startIndex > deferNode.endIndex)
          .find((call) => {
            const selected = selectedMethod(call, source);
            return selected === contract.operation || selected?.startsWith(contract.operation) === true;
          });
        if (completionCall === undefined) continue;

        const earlyReturn = descendants(body, "return_statement")
          .filter((statement) =>
            owningFunction(statement)?.id === fn.id &&
            statement.startIndex > deferNode.endIndex &&
            statement.startIndex < completionCall.startIndex &&
            !staticallyDead(statement, source))
          .find((statement) => {
            const context = stripComments(
              source.slice(Math.max(deferNode.endIndex, statement.startIndex - 600), statement.endIndex),
            );
            return NON_SUCCESS_PATH.test(context);
          });
        if (earlyReturn === undefined) continue;

        result.push({
          signature: [
            functionName,
            contract.identifier,
            contract.operation,
            normalize(sourceText(deferNode, source)),
            normalize(sourceText(earlyReturn, source)),
            selectedMethod(completionCall, source) ?? "",
          ].join("|"),
          functionName,
          metric: contract.identifier,
          operation: contract.operation,
          deferNode,
          metricCall,
          completionCall,
          earlyReturn,
        });
      }
    }
  }
  return result;
}

function signatureCounts(items: Candidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.signature, (counts.get(item.signature) ?? 0) + 1);
  return counts;
}

function selectedMethod(call: Node, source: string): string | undefined {
  const fn = call.childForFieldName("function");
  if (fn === null) return undefined;
  if (fn.type === "identifier") return sourceText(fn, source);
  if (fn.type !== "selector_expression") return undefined;
  const field = fn.childForFieldName("field");
  return field === null ? undefined : sourceText(field, source);
}

function contractMatchesCall(
  contract: MetricContract,
  callText: string,
  imports: Map<string, string>,
  packageName: string,
  fileDirectory: string,
): boolean {
  const reference = new RegExp(`(?:\\b([A-Za-z_]\\w*)\\s*\\.\\s*)?\\b${escapeRegExp(contract.identifier)}\\b`)
    .exec(callText);
  if (reference === null) return false;
  const qualifier = reference[1];
  if (qualifier === undefined) {
    return contract.packageName === packageName && contract.directory === fileDirectory;
  }
  const importedPath = imports.get(qualifier);
  if (importedPath === undefined) return false;
  return importedPath === contract.directory || importedPath.endsWith(`/${contract.directory}`);
}

function importAliases(root: Node, source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const spec of descendants(root, "import_spec")) {
    const match = /^(?:([A-Za-z_]\w*|[_.])\s+)?["`]([^"`]+)["`]$/.exec(sourceText(spec, source).trim());
    if (match === null) continue;
    const importedPath = match[2]!;
    const alias = match[1] ?? importedPath.split("/").pop()!;
    if (alias !== "_" && alias !== ".") result.set(alias, importedPath);
  }
  return result;
}

function successGuarded(call: Node, deferredBody: Node, source: string): boolean {
  for (let node = call.parent; node !== null && node.id !== deferredBody.id; node = node.parent) {
    if (node.type !== "if_statement") continue;
    const condition = node.childForFieldName("condition");
    if (condition === null) continue;
    const text = normalize(sourceText(condition, source));
    if (/\b(?:success|succeeded|completed)\b/i.test(text)) return true;
    if (/\b(?:err|error)\s*==\s*nil\b|\bnil\s*==\s*(?:err|error)\b/.test(text)) return true;
    if (/\bresult\s*!=\s*nil\b|\bnil\s*!=\s*result\b/.test(text)) return true;
  }
  return false;
}

function owningFunction(node: Node): Node | undefined {
  for (let current: Node | null = node.parent; current !== null; current = current.parent) {
    if (current.type === "func_literal" || current.type === "function_declaration" || current.type === "method_declaration") {
      return current;
    }
  }
  return undefined;
}

function staticallyDead(node: Node, source: string): boolean {
  for (let current: Node | null = node.parent; current !== null; current = current.parent) {
    if (current.type !== "if_statement") continue;
    const consequence = current.childForFieldName("consequence");
    const alternative = current.childForFieldName("alternative");
    const condition = current.childForFieldName("condition");
    if (condition === null) continue;
    const value = normalize(sourceText(condition, source)).replace(/^\((.*)\)$/s, "$1");
    if (value === "false" && consequence !== null && contains(consequence, node)) return true;
    if (value === "true" && alternative !== null && contains(alternative, node)) return true;
  }
  return false;
}

function contains(parent: Node, child: Node): boolean {
  return parent.startIndex <= child.startIndex && child.endIndex <= parent.endIndex;
}

function changedAnchor(file: SourceRevision, nodes: Node[]): number | undefined {
  for (const node of nodes) {
    const start = node.startPosition.row + 1;
    const end = node.endPosition.row + 1;
    if (file.status === "repository" || file.status === "added") return start;
    for (let line = start; line <= end; line += 1) {
      if (file.changedLines.has(line)) return line;
    }
  }
  return undefined;
}

function lineText(source: string, line: number): string {
  return source.split("\n")[line - 1]?.trim().slice(0, 300) ?? "";
}

function normalize(text: string): string {
  return stripComments(text).replace(/\s+/g, "");
}

function stripComments(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}
