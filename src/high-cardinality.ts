import { descendants, parseGo, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

const PROMETHEUS_PACKAGE = "github.com/prometheus/client_golang/prometheus";
const VECTOR_CONSTRUCTOR = /^New(?:Counter|Gauge|Histogram|Summary)Vec$/;
const UNBOUNDED_LABEL = /(?:^|[^a-z0-9])(?:user_?id|email|request_?id|session(?:_?id)?|trace_?id|path|url|error)(?:$|[^a-z0-9])/i;

interface Candidate {
  signature: string;
  message: string;
  data: Record<string, unknown>;
  primary: Node;
  evidence: Node[];
}

interface ImportInfo {
  path: string;
  node: Node;
}

/**
 * Reports high-cardinality Prometheus dimensions only after proving an actual
 * metric label boundary. Ordinary []string data is not telemetry merely
 * because one element contains words such as path, URL, or error.
 */
export async function highCardinalitySignals(files: SourceRevision[]): Promise<Signal[]> {
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
      for (const candidate of current) {
        const occurrence = (currentCounts.get(candidate.signature) ?? 0) + 1;
        currentCounts.set(candidate.signature, occurrence);
        if (file.status === "modified" && occurrence <= (previousCounts.get(candidate.signature) ?? 0)) continue;
        const line = changedAnchor(file, candidate.evidence);
        if (line === undefined) continue;
        signals.push({
          ruleId: "go-obs.metrics.high-cardinality",
          path: file.path,
          line,
          message: candidate.message,
          snippet: sourceText(candidate.primary, file.current).trim().slice(0, 300),
          data: candidate.data,
        });
      }
    } finally {
      previousTree?.delete();
      currentTree.delete();
    }
  }
  return signals.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function candidates(root: Node, source: string): Candidate[] {
  const imports = importAliases(root, source);
  return [
    ...labelNameCandidates(root, source, imports),
    ...labelValueCandidates(root, source),
    ...labelsMapCandidates(root, source, imports),
  ];
}

function labelNameCandidates(root: Node, source: string, imports: Map<string, ImportInfo>): Candidate[] {
  const result: Candidate[] = [];
  const sliceDefinitions = stringSliceDefinitions(root, source);
  for (const call of descendants(root, "call_expression")) {
    const fn = call.childForFieldName("function");
    const args = call.childForFieldName("arguments");
    if (fn === null || args === null || args.namedChildCount < 2) continue;
    const selected = prometheusSelection(fn, source, imports);
    if (selected === undefined || !VECTOR_CONSTRUCTOR.test(selected.method)) continue;
    const labelsArg = args.namedChild(1);
    if (labelsArg === null) continue;

    let labels: string[] = [];
    let primary = labelsArg;
    const evidence = [labelsArg, fn, selected.importNode];
    if (isStringSlice(labelsArg, source)) {
      labels = stringValues(labelsArg, source);
    } else if (labelsArg.type === "identifier") {
      const name = sourceText(labelsArg, source);
      const definitions = sliceDefinitions.filter((definition) =>
        definition.name === name && definitionVisibleAt(definition, call, source),
      );
      if (definitions.length !== 1) continue;
      const definition = definitions[0]!;
      if (bindingReassigned(definition, call, source)) continue;
      labels = definition.labels;
      primary = definition.literal;
      evidence.unshift(definition.literal);
    } else {
      continue;
    }

    const unbounded = labels.filter((label) => UNBOUNDED_LABEL.test(label));
    if (unbounded.length === 0) continue;
    result.push({
      signature: `names|${selected.method}|${[...labels].map(normalize).sort().join(",")}`,
      message: "This Prometheus vector declares a request- or user-specific label dimension.",
      data: { labels: unbounded, boundary: "prometheus-vector-label-names" },
      primary,
      evidence,
    });
  }
  return result;
}

function labelValueCandidates(root: Node, source: string): Candidate[] {
  const result: Candidate[] = [];
  for (const call of descendants(root, "call_expression")) {
    const fn = call.childForFieldName("function");
    const args = call.childForFieldName("arguments");
    if (fn?.type !== "selector_expression" || args === null) continue;
    const field = fn.childForFieldName("field");
    if (field === null || sourceText(field, source) !== "WithLabelValues") continue;
    const unbounded: string[] = [];
    const evidence: Node[] = [call];
    for (const argument of args.namedChildren) {
      const kind = unboundedValueKind(argument, source);
      if (kind === undefined) continue;
      unbounded.push(kind);
      evidence.unshift(argument);
    }
    if (unbounded.length === 0) continue;
    result.push({
      signature: `values|${unbounded.join(",")}|${normalize(sourceText(fn, source))}`,
      message: "WithLabelValues receives an unbounded request- or user-specific value.",
      data: { values: unbounded, boundary: "with-label-values" },
      primary: call,
      evidence,
    });
  }
  return result;
}

function labelsMapCandidates(root: Node, source: string, imports: Map<string, ImportInfo>): Candidate[] {
  const result: Candidate[] = [];
  for (const literal of descendants(root, "composite_literal")) {
    const typeNode = literal.childForFieldName("type") ?? literal.namedChild(0);
    if (typeNode === null || typeNode.type !== "qualified_type") continue;
    const typeText = sourceText(typeNode, source).replace(/\s+/g, "");
    const match = /^([A-Za-z_]\w*)\.Labels$/.exec(typeText);
    if (match === null) continue;
    const imported = imports.get(match[1]!);
    if (imported?.path !== PROMETHEUS_PACKAGE || !importAvailableAt(match[1]!, literal, source)) continue;
    const body = literal.childForFieldName("body") ?? literal.namedChild(1);
    if (body === null) continue;
    const keys = descendants(body, "keyed_element")
      .map((element) => element.childForFieldName("key") ?? element.namedChild(0))
      .filter((node): node is Node => node !== null)
      .map((node) => {
        const literal = isStringLiteral(node)
          ? node
          : descendants(node, "interpreted_string_literal")[0] ?? descendants(node, "raw_string_literal")[0];
        return literal === undefined ? undefined : { node: literal, value: stringValue(literal, source) };
      })
      .filter((item): item is { node: Node; value: string } => item !== undefined)
      .filter((item) => UNBOUNDED_LABEL.test(item.value));
    if (keys.length === 0) continue;
    result.push({
      signature: `map|${keys.map((item) => normalize(item.value)).sort().join(",")}`,
      message: "A prometheus.Labels map uses a high-cardinality key.",
      data: { labels: keys.map((item) => item.value), boundary: "prometheus-labels-map" },
      primary: literal,
      evidence: [...keys.map((item) => item.node), typeNode, imported.node],
    });
  }
  return result;
}

interface SliceDefinition {
  name: string;
  labels: string[];
  literal: Node;
  declaration: Node;
  owner?: Node;
}

function stringSliceDefinitions(root: Node, source: string): SliceDefinition[] {
  const result: SliceDefinition[] = [];
  for (const literal of descendants(root, "composite_literal")) {
    if (!isStringSlice(literal, source)) continue;
    let declaration: Node | null = literal.parent;
    while (declaration !== null && !["short_var_declaration", "assignment_statement", "var_spec"].includes(declaration.type)) {
      if (declaration.type === "call_expression" || owningFunction(declaration)?.id !== owningFunction(literal)?.id) {
        declaration = null;
        break;
      }
      declaration = declaration.parent;
    }
    if (declaration === null) continue;
    const match = /^(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|=)/s.exec(sourceText(declaration, source).trim());
    if (match === null) continue;
    const owner = owningFunction(declaration);
    result.push({
      name: match[1]!,
      labels: stringValues(literal, source),
      literal,
      declaration,
      ...(owner === undefined ? {} : { owner }),
    });
  }
  return result;
}

function definitionVisibleAt(definition: SliceDefinition, call: Node, source: string): boolean {
  const callOwner = owningFunction(call);
  if (definition.owner === undefined) return true;
  if (callOwner?.id !== definition.owner.id || definition.declaration.startIndex >= call.startIndex) return false;
  return !bindingDeclaredBetween(definition.owner, definition.name, definition.declaration.endIndex, call.startIndex, source);
}

function bindingReassigned(definition: SliceDefinition, call: Node, source: string): boolean {
  const owner = owningFunction(call);
  if (owner === undefined) return false;
  return descendants(owner, "assignment_statement").some((assignment) => {
    if (assignment.id === definition.declaration.id || assignment.startIndex <= definition.declaration.endIndex || assignment.endIndex >= call.startIndex) return false;
    const left = assignment.childForFieldName("left") ?? assignment.namedChild(0);
    return left !== null && sourceText(left, source).trim() === definition.name;
  });
}

function bindingDeclaredBetween(owner: Node, name: string, start: number, end: number, source: string): boolean {
  return descendants(owner, "short_var_declaration").some((declaration) => {
    if (declaration.startIndex <= start || declaration.endIndex >= end) return false;
    const left = declaration.childForFieldName("left") ?? declaration.namedChild(0);
    return left !== null && sourceText(left, source).split(",").map((item) => item.trim()).includes(name);
  });
}

function prometheusSelection(
  fn: Node,
  source: string,
  imports: Map<string, ImportInfo>,
): { method: string; importNode: Node } | undefined {
  if (fn.type !== "selector_expression") return undefined;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (operand?.type !== "identifier" || field === null) return undefined;
  const alias = sourceText(operand, source);
  const imported = imports.get(alias);
  if ((imported?.path !== PROMETHEUS_PACKAGE && imported?.path !== `${PROMETHEUS_PACKAGE}/promauto`) ||
      !importAvailableAt(alias, fn, source)) return undefined;
  return { method: sourceText(field, source), importNode: imported.node };
}

function importAliases(root: Node, source: string): Map<string, ImportInfo> {
  const result = new Map<string, ImportInfo>();
  for (const spec of descendants(root, "import_spec")) {
    const match = /^(?:([A-Za-z_]\w*|[_.])\s+)?["`]([^"`]+)["`]$/.exec(sourceText(spec, source).trim());
    if (match === null) continue;
    const importedPath = match[2]!;
    const alias = match[1] ?? importedPath.split("/").pop()!;
    if (alias !== "_" && alias !== ".") result.set(alias, { path: importedPath, node: spec });
  }
  return result;
}

function importAvailableAt(alias: string, use: Node, source: string): boolean {
  const owner = owningFunction(use);
  if (owner === undefined) return true;
  const body = owner.childForFieldName("body");
  if (body === null) return false;
  const header = sourceText(owner, source).slice(0, body.startIndex - owner.startIndex);
  if (new RegExp(`[(,]\\s*${escapeRegExp(alias)}\\s+`).test(header)) return false;
  const before = source.slice(body.startIndex, use.startIndex);
  return !new RegExp(
    `(?:\\bvar\\s+${escapeRegExp(alias)}\\b|\\b${escapeRegExp(alias)}\\s*:=|(?:^|[,;(])\\s*${escapeRegExp(alias)}\\s*(?:,|:=|=|\\brange\\b))`,
    "m",
  ).test(before);
}

function isStringSlice(node: Node, source: string): boolean {
  if (node.type !== "composite_literal") return false;
  const typeNode = node.childForFieldName("type") ?? node.namedChild(0);
  return typeNode !== null && normalize(sourceText(typeNode, source)) === "[]string";
}

function stringValues(node: Node, source: string): string[] {
  return descendants(node, "interpreted_string_literal")
    .concat(descendants(node, "raw_string_literal"))
    .map((literal) => stringValue(literal, source));
}

function isStringLiteral(node: Node): boolean {
  return node.type === "interpreted_string_literal" || node.type === "raw_string_literal";
}

function stringValue(node: Node, source: string): string {
  const text = sourceText(node, source);
  return text.length >= 2 ? text.slice(1, -1).toLowerCase() : text.toLowerCase();
}

function unboundedValueKind(argument: Node, source: string): string | undefined {
  if (isStringLiteral(argument)) return undefined;
  const text = normalize(sourceText(argument, source));
  if (/\.URL\.(?:Path|String\(\))$/i.test(text)) return "request-url";
  if (/\buser_?id\b/i.test(text)) return "user-id";
  if (/\brequest_?id\b/i.test(text)) return "request-id";
  if (/\berr(?:or)?\.Error\(\)$/i.test(text)) return "error-text";
  return undefined;
}

function owningFunction(node: Node): Node | undefined {
  for (let current: Node | null = node.parent; current !== null; current = current.parent) {
    if (["func_literal", "function_declaration", "method_declaration"].includes(current.type)) return current;
  }
  return undefined;
}

function signatureCounts(items: Candidate[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.signature, (counts.get(item.signature) ?? 0) + 1);
  return counts;
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

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
