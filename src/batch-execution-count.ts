import { descendants, parseGo } from "./parser.js";
import type { Node } from "web-tree-sitter";
import type { Signal, SourceRevision } from "./types.js";

const RULE = "go-obs.metrics.planned-batch-as-executed";

/** Conservative same-file proof: an imported counter's Help promises completed
 * work, but Add(len(batch)) follows a loop whose work error breaks/continues.
 * Cross-package execution histories and opaque reporting helpers are not guessed.
 */
export async function batchExecutionCountSignals(files: SourceRevision[]): Promise<Signal[]> {
  const result: Signal[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".go") || file.path.endsWith("_test.go")) continue;
    const tree = await parseGo(file.current);
    const previous = file.previous === undefined ? undefined : await parseGo(file.previous);
    try {
      if (tree.rootNode.hasError) continue;
      const old = previous && !previous.rootNode.hasError ? batchCountCandidates(previous.rootNode) : [];
      for (const candidate of batchCountCandidates(tree.rootNode)) {
        // Compare semantic relationships, ignoring comments and whitespace.
        if (file.status === "modified" && (previous === undefined || previous.rootNode.hasError ||
            old.some((x) => x.signature === candidate.signature))) continue;
        const anchor = candidate.nodes.find((node) => file.status !== "modified" ||
          Array.from({ length: node.endPosition.row - node.startPosition.row + 1 }, (_, i) => node.startPosition.row + i + 1)
            .some((line) => file.changedLines.has(line)));
        if (!anchor) continue;
        result.push({ ruleId: RULE, path: file.path, line: anchor.startPosition.row + 1,
          message: `${candidate.metric} counts completed work, but records the full ${candidate.batch} length after a work error can ${candidate.exit} the batch loop.`,
          snippet: anchor.text.slice(0, 300), data: { metric: candidate.metric, batch: candidate.batch,
            earlyExit: candidate.exit, emissionLine: candidate.nodes[0]!.startPosition.row + 1,
            scope: "same-file-direct-batch-counter" } });
      }
    } finally { previous?.delete(); tree.delete(); }
  }
  return result;
}

function batchCountSignature(node: Node): string {
  if (node.type === "comment") return "";
  return node.namedChildCount ? node.namedChildren.map(batchCountSignature).join("|") : node.text.replace(/\s/g, "");
}
function batchStatements(block: Node | null): Node[] {
  return block?.namedChildren.flatMap((n) => n.type === "statement_list" ? n.namedChildren : [n])
    .filter((n) => n.type !== "comment") ?? [];
}
function batchDeclares(root: Node, name: string): boolean {
  return descendants(root, "identifier").some((node) => {
    if (node.text !== name) return false;
    let parent = node.parent;
    if (parent?.type === "expression_list") {
      const assignment = parent.parent;
      return assignment?.type === "short_var_declaration" && assignment.childForFieldName("left")?.id === parent.id;
    }
    return ["parameter_declaration", "var_spec", "const_spec", "type_spec", "function_declaration"].includes(parent?.type ?? "") &&
      parent?.childForFieldName("name")?.id === node.id;
  });
}
function batchCountCandidates(root: Node) {
  const matches: Array<{ metric: string; batch: string; exit: string; nodes: Node[]; signature: string }> = [];
  const imports = descendants(root, "import_spec").flatMap((n) => {
    const m = /^(?:(\w+)\s+)?"github.com\/prometheus\/client_golang\/prometheus"$/.exec(n.text);
    return m ? [m[1] ?? "prometheus"] : [];
  });
  for (const decl of root.namedChildren.filter((n) => n.type === "var_declaration")) {
    for (const spec of descendants(decl, "var_spec")) {
      const name = spec.childForFieldName("name");
      const value = spec.childForFieldName("value");
      const call = value?.namedChildren[0];
      if (!name || name.type !== "identifier" || !call || call.type !== "call_expression") continue;
      const callee = call.childForFieldName("function")?.text;
      const alias = imports.find((a) => callee === `${a}.NewCounter`);
      if (!alias) continue;
      const args = call.childForFieldName("arguments")?.namedChildren;
      if (args?.length !== 1 || args[0]?.type !== "composite_literal" ||
          args[0].childForFieldName("type")?.text !== `${alias}.CounterOpts`) continue;
      const help = descendants(args[0], "keyed_element").find((n) => n.namedChildren[0]?.text === "Help")?.namedChildren[1];
      if (!help || !/^"[^"\\]*\b(?:successful|successfully (?:completed|processed))\b[^"\\]*"$/i.test(help.text) ||
          /\b(?:not|non|uncompleted|planned|selected|scheduled|attempts|failed|failure|all outcomes)\b/i.test(help.text)) continue;
      const metric = name.text;
      // Reject writes, local shadowing, or passing the counter to opaque code.
      const identifiers = descendants(root, "identifier").filter((n) => n.text === metric && n.id !== name.id);
      if (identifiers.some((n) => n.parent?.type !== "selector_expression" ||
          n.parent.childForFieldName("operand")?.id !== n.id)) continue;
      for (const fn of root.namedChildren.filter((n) => n.type === "function_declaration")) {
        const body = fn.childForFieldName("body");
        const ss = batchStatements(body);
        for (let index = 0; index < ss.length - 1; index++) {
          const loop = ss[index]!; const emission = ss[index + 1]!;
          if (loop.type !== "for_statement" || emission.type !== "expression_statement") continue;
          const range = loop.namedChildren.find((n) => n.type === "range_clause");
          const batchNode = range?.childForFieldName("right");
          const lhs = range?.childForFieldName("left");
          if (!batchNode || batchNode.type !== "identifier" || !lhs) continue;
          const batch = batchNode.text;
          const parameter = descendants(fn.childForFieldName("parameters")!, "parameter_declaration")
            .find((n) => n.childForFieldName("name")?.text === batch && n.childForFieldName("type")?.type === "slice_type");
          if (!parameter) continue;
          const item = lhs.namedChildren;
          if (item.length !== 2 || item[0]?.text !== "_" || item[1]?.type !== "identifier") continue;
          const itemName = item[1]!.text;
          const emitCall = emission.namedChildren[0];
          if (emitCall?.type !== "call_expression" || emitCall.childForFieldName("function")?.text !== `${metric}.Add`) continue;
          const emitArgs = emitCall.childForFieldName("arguments")?.namedChildren;
          if (emitArgs?.length !== 1 || emitArgs[0]?.text.replace(/\s/g, "") !== `float64(len(${batch}))`) continue;
          const loopStatements = batchStatements(loop.childForFieldName("body"));
          // An exact immediate error check proves the failed item's contribution
          // is still included; arbitrary nested control flow is intentionally out.
          if (loopStatements.length !== 1 || loopStatements[0]?.type !== "if_statement") continue;
          const guard = loopStatements[0];
          if (guard.childForFieldName("alternative")) continue;
          const init = guard.childForFieldName("initializer");
          if (init?.type !== "short_var_declaration") continue;
          const err = init.childForFieldName("left")?.text;
          const work = init.childForFieldName("right")?.namedChildren[0];
          if (!err || !/^[A-Za-z_]\w*$/.test(err) || err === "_" || work?.type !== "call_expression") continue;
          const workArgs = work.childForFieldName("arguments")?.namedChildren;
          if (workArgs?.length !== 1 || workArgs[0]?.text !== itemName) continue;
          if (guard.childForFieldName("condition")?.text.replace(/\s/g, "") !== `${err}!=nil`) continue;
          const exits = batchStatements(guard.childForFieldName("consequence"));
          if (exits.length !== 1 || !["break_statement", "continue_statement"].includes(exits[0]!.type) || exits[0]!.namedChildCount !== 0) continue;
          // The slice must not be rebound/mutated before or within the loop.
          const uses = descendants(fn, "identifier").filter((n) => n.text === batch);
          if (uses.some((n) => n.startIndex < loop.endIndex && n.id !== batchNode.id &&
              n.startIndex !== parameter.childForFieldName("name")?.startIndex)) continue;
          // Builtins/import aliases must not be shadowed in this function.
          if (["len", "float64", alias].some((name) => batchDeclares(root, name))) continue;
          const nodes = [emission, guard, range!, help];
          matches.push({ metric, batch, exit: exits[0]!.text, nodes,
            signature: [metric, fn.childForFieldName("name")?.text, ...nodes.map(batchCountSignature)].join(":" ) });
        }
      }
    }
  }
  return matches;
}
