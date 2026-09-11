import { descendants, parseGo } from "./parser.js";
import type { Node } from "web-tree-sitter";
import type { Signal, SourceRevision } from "./types.js";

const RULE = "go-obs.metrics.planned-batch-as-executed";
interface Contract { metric: string; help: Node }
interface Candidate { metric: string; batch: string; exit: string; nodes: Node[]; signature: string }

/** Direct same-file proof only; opaque result/reporting helpers are not guessed. */
export async function batchExecutionCountSignals(files: SourceRevision[]): Promise<Signal[]> {
  const result: Signal[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".go") || file.path.endsWith("_test.go")) continue;
    result.push(...await batchFileSignals(file));
  }
  return result;
}

async function batchFileSignals(file: SourceRevision): Promise<Signal[]> {
  const tree = await parseGo(file.current);
  const previous = file.previous === undefined ? undefined : await parseGo(file.previous);
  try {
    if (tree.rootNode.hasError) return [];
    if (file.status === "modified" && (!previous || previous.rootNode.hasError)) return [];
    const old = previous ? batchCountCandidates(previous.rootNode) : [];
    return batchCountCandidates(tree.rootNode).flatMap((candidate) => {
      if (file.status === "modified" && old.some((x) => x.signature === candidate.signature)) return [];
      const anchor = candidate.nodes.find((node) => touchesChange(file, node));
      if (!anchor) return [];
      return [{ ruleId: RULE, path: file.path, line: anchor.startPosition.row + 1,
        message: `${candidate.metric} counts successful work, but records the full ${candidate.batch} length after a work error can ${candidate.exit} the batch loop.`,
        snippet: anchor.text.slice(0, 300), data: { metric: candidate.metric, batch: candidate.batch,
          earlyExit: candidate.exit, emissionLine: candidate.nodes[0]!.startPosition.row + 1,
          scope: "same-file-direct-batch-counter" } }];
    });
  } finally { previous?.delete(); tree.delete(); }
}

function touchesChange(file: SourceRevision, node: Node): boolean {
  if (file.status !== "modified") return true;
  for (let line = node.startPosition.row + 1; line <= node.endPosition.row + 1; line++) {
    if (file.changedLines.has(line)) return true;
  }
  return false;
}
function batchCountSignature(node: Node): string {
  if (node.type === "comment") return "";
  return node.namedChildCount ? node.namedChildren.map(batchCountSignature).join("|") : node.text.replace(/\s/g, "");
}
function batchStatements(block: Node | null): Node[] {
  return block?.namedChildren.flatMap((n) => n.type === "statement_list" ? n.namedChildren : [n])
    .filter((n) => n.type !== "comment") ?? [];
}
function containsNode(scope: Node, node: Node): boolean {
  return scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex;
}
function bindingScope(node: Node): Node | undefined {
  let parent = node.parent;
  while (parent) {
    if (["block", "if_statement", "for_statement", "expression_switch_statement", "type_switch_statement", "function_declaration", "func_literal", "source_file"].includes(parent.type)) return parent;
    parent = parent.parent;
  }
  return undefined;
}
function declaration(node: Node): Node | undefined {
  const parent = node.parent;
  if (parent?.type === "expression_list") {
    const assignment = parent.parent;
    return assignment?.type === "short_var_declaration" && assignment.childForFieldName("left")?.id === parent.id ? assignment : undefined;
  }
  return ["parameter_declaration", "var_spec", "const_spec", "type_spec", "function_declaration"].includes(parent?.type ?? "") &&
    parent?.childForFieldName("name")?.id === node.id ? parent : undefined;
}
/** Only bindings whose lexical scope includes the use can hide an import/builtin. */
function batchShadowed(root: Node, name: string, use: Node): boolean {
  return descendants(root, "identifier").some((node) => {
    if (node.text !== name) return false;
    const decl = declaration(node);
    if (!decl) return false;
    // A function's own name belongs to its enclosing package scope.
    const scope = bindingScope(decl);
    if (!scope || !containsNode(scope, use)) return false;
    return scope.type === "source_file" || decl.type === "parameter_declaration" || decl.endIndex <= use.startIndex;
  });
}

function metricContract(spec: Node, root: Node, aliases: string[]): Contract | undefined {
  const name = spec.childForFieldName("name");
  const call = spec.childForFieldName("value")?.namedChildren[0];
  if (!name || name.type !== "identifier" || call?.type !== "call_expression") return undefined;
  const alias = aliases.find((a) => call.childForFieldName("function")?.text === `${a}.NewCounter`);
  if (!alias || batchShadowed(root, alias, call)) return undefined;
  const args = call.childForFieldName("arguments")?.namedChildren;
  if (args?.length !== 1 || args[0]?.type !== "composite_literal" ||
      args[0].childForFieldName("type")?.text !== `${alias}.CounterOpts`) return undefined;
  const help = descendants(args[0], "keyed_element").find((n) => n.namedChildren[0]?.text === "Help")?.namedChildren[1];
  if (!help || !/^"[^"\\]*\b(?:successful|successfully (?:completed|processed))\b[^"\\]*"$/i.test(help.text) ||
      /\b(?:not|non|uncompleted|planned|selected|scheduled|attempts|failed|failure|all outcomes)\b/i.test(help.text)) return undefined;
  const metric = name.text;
  // Reject writes or opaque use of this counter; unrelated local bindings are
  // resolved separately at each emission rather than invalidating the file.
  const uses = descendants(root, "identifier").filter((n) => n.text === metric && n.id !== name.id && !declaration(n));
  if (uses.some((n) => !batchShadowedLocally(root, metric, n) &&
      (n.parent?.type !== "selector_expression" || n.parent.childForFieldName("operand")?.id !== n.id))) return undefined;
  return { metric, help };
}
function batchShadowedLocally(root: Node, name: string, use: Node): boolean {
  const fn = root.namedChildren.find((n) => n.type === "function_declaration" && containsNode(n, use));
  return fn !== undefined && batchShadowed(fn, name, use);
}
function metricContracts(root: Node): Contract[] {
  const aliases = descendants(root, "import_spec").flatMap((n) => {
    const m = /^(?:(\w+)\s+)?"github.com\/prometheus\/client_golang\/prometheus"$/.exec(n.text);
    return m ? [m[1] ?? "prometheus"] : [];
  });
  return root.namedChildren.filter((n) => n.type === "var_declaration")
    .flatMap((n) => descendants(n, "var_spec"))
    .flatMap((n) => { const contract = metricContract(n, root, aliases); return contract ? [contract] : []; });
}
function directWorkFailure(loop: Node, item: string): { guard: Node; exit: string } | undefined {
  const ss = batchStatements(loop.childForFieldName("body"));
  const guard = ss[0];
  if (ss.length !== 1 || guard?.type !== "if_statement" || guard.childForFieldName("alternative")) return undefined;
  const init = guard.childForFieldName("initializer");
  if (init?.type !== "short_var_declaration") return undefined;
  const err = init.childForFieldName("left")?.text;
  const work = init.childForFieldName("right")?.namedChildren[0];
  if (!err || !/^[A-Za-z_]\w*$/.test(err) || err === "_" || work?.type !== "call_expression") return undefined;
  const args = work.childForFieldName("arguments")?.namedChildren;
  if (args?.length !== 1 || args[0]?.text !== item) return undefined;
  if (guard.childForFieldName("condition")?.text.replace(/\s/g, "") !== `${err}!=nil`) return undefined;
  const exits = batchStatements(guard.childForFieldName("consequence"));
  if (exits.length !== 1 || !["break_statement", "continue_statement"].includes(exits[0]!.type) || exits[0]!.namedChildCount !== 0) return undefined;
  return { guard, exit: exits[0]!.text };
}
function matchBatch(root: Node, fn: Node, loop: Node, emission: Node, contract: Contract): Candidate | undefined {
  if (loop.type !== "for_statement" || emission.type !== "expression_statement") return undefined;
  const range = loop.namedChildren.find((n) => n.type === "range_clause");
  const batchNode = range?.childForFieldName("right");
  const lhs = range?.childForFieldName("left");
  if (!batchNode || batchNode.type !== "identifier" || !lhs) return undefined;
  const batch = batchNode.text;
  const parameter = descendants(fn.childForFieldName("parameters")!, "parameter_declaration")
    .find((n) => n.childForFieldName("name")?.text === batch && n.childForFieldName("type")?.type === "slice_type");
  if (!parameter) return undefined;
  const item = lhs.namedChildren;
  if (item.length !== 2 || item[0]?.text !== "_" || item[1]?.type !== "identifier") return undefined;
  const emitCall = emission.namedChildren[0];
  if (emitCall?.type !== "call_expression" || emitCall.childForFieldName("function")?.text !== `${contract.metric}.Add`) return undefined;
  const args = emitCall.childForFieldName("arguments")?.namedChildren;
  if (args?.length !== 1 || args[0]?.text.replace(/\s/g, "") !== `float64(len(${batch}))`) return undefined;
  const failure = directWorkFailure(loop, item[1]!.text);
  if (!failure) return undefined;
  const uses = descendants(fn, "identifier").filter((n) => n.text === batch);
  if (uses.some((n) => n.startIndex < loop.endIndex && n.id !== batchNode.id &&
      n.startIndex !== parameter.childForFieldName("name")?.startIndex)) return undefined;
  if (["len", "float64"].some((name) => batchShadowed(root, name, emission)) || batchShadowedLocally(root, contract.metric, emission)) return undefined;
  // Help remains contract evidence but cannot anchor or create a semantic code change.
  const nodes = [emission, failure.guard, range!];
  return { metric: contract.metric, batch, exit: failure.exit, nodes,
    signature: [contract.metric, fn.childForFieldName("name")?.text, ...nodes.map(batchCountSignature)].join(":") };
}
function batchCountCandidates(root: Node): Candidate[] {
  const contracts = metricContracts(root);
  return root.namedChildren.filter((n) => n.type === "function_declaration").flatMap((fn) => {
    const ss = batchStatements(fn.childForFieldName("body"));
    return ss.slice(0, -1).flatMap((loop, index) => contracts.flatMap((contract) => {
      const match = matchBatch(root, fn, loop, ss[index + 1]!, contract);
      return match ? [match] : [];
    }));
  });
}
