import assert from "node:assert/strict";
import test from "node:test";
import { batchExecutionCountSignals } from "../src/batch-execution-count.ts";
import type { SourceRevision } from "../src/types.ts";

const code = `package worker
import "github.com/prometheus/client_golang/prometheus"
var done = prometheus.NewCounter(prometheus.CounterOpts{
  Name: "jobs_completed_total", Help: "Number of successful jobs.",
})
func run(items []Job) {
  for _, item := range items {
    if err := process(item); err != nil { break }
  }
  done.Add(float64(len(items)))
}
`;
function source(current: string, extra: Partial<SourceRevision> = {}): SourceRevision {
  return { path: "worker.go", current, status: "added", changedLines: new Set(), ...extra };
}

test("counts the full batch after failure can stop or skip completed work", async () => {
  for (const exit of ["break", "continue"]) {
    const result = await batchExecutionCountSignals([source(code.replace("{ break }", `{ ${exit} }`))]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.ruleId, "go-obs.metrics.planned-batch-as-executed");
    assert.equal(result[0]?.line, 10);
    assert.equal(result[0]?.data.earlyExit, exit);
  }
});

test("clean counting contracts and guarded/actual completion stay quiet", async () => {
  for (const clean of [
    code.replace("Number of successful jobs.", "Number of completed jobs."),
    code.replace("Number of successful jobs.", "Number of planned jobs."),
    code.replace("Number of successful jobs.", "Number of attempted jobs, including failures."),
    code.replace("{ break }", "{ return }"),
    code.replace("{ break }", "{ return }").replace("  done.Add(float64(len(items)))", "  done.Add(float64(completed))"),
    code.replace("  done.Add(float64(len(items)))", "  if successful { done.Add(float64(len(items))) }"),
    code.replace("if err := process(item); err != nil { break }", "if err := process(item); err != nil { continue }; done.Inc()").replace("  done.Add(float64(len(items)))", ""),
    code.replace("Number of successful jobs.", "Number of jobs not completed."),
  ]) assert.deepEqual(await batchExecutionCountSignals([source(clean)]), []);
});

test("does not guess aliases, opaque loops, fake counters, mutations, or tests", async () => {
  for (const clean of [
    code.replace("github.com/prometheus/client_golang/prometheus", "example.com/prometheus"),
    code.replace("func run(items []Job) {", "func run(items []Job) { done := otherCounter;"),
    code.replace("for _, item := range items", "for _, item := range otherItems"),
    code.replace("for _, item := range items", "items = otherItems; for _, item := range items"),
    code.replace("process(item)", "predicate()"),
    code.replace("func run(items []Job) {", "func run(items []Job) { len := customLength;"),
    code.replace("func run(items []Job) {", "func run(items []Job, float64 func(int) float64) {"),
    code + "\nfunc len(items []Job) int { return 0 }\n",
    code.replace("if err := process(item); err != nil { break }", "if stop { break }; process(item)"),
    code.replace("{ break }", "{ retry(item); break }"),
    code.replace("done.Add(float64(len(items)))", "done.Add(1)"),
  ]) assert.deepEqual(await batchExecutionCountSignals([source(clean)]), []);
  assert.deepEqual(await batchExecutionCountSignals([source(code, { path: "worker_test.go" })]), []);
  assert.deepEqual(await batchExecutionCountSignals([source(code + "func broken(")]), []);
});

test("honors changed semantic relationships and ignores unchanged or comment-only changes", async () => {
  assert.equal((await batchExecutionCountSignals([source(code, { status: "modified", previous: code.replace("{ break }", "{ return }"), changedLines: new Set([8]) })])).length, 1);
  for (const previous of [code, code.replace("  done.Add", "  // prior comment\n  done.Add")]) {
    assert.deepEqual(await batchExecutionCountSignals([source(code, { status: "modified", previous, changedLines: new Set([10]) })]), []);
  }
  assert.deepEqual(await batchExecutionCountSignals([source(code, { status: "modified", previous: code.replace("{ break }", "{ return }"), changedLines: new Set([1]) })]), []);
});


test("the new batch-count signal is included in normal discovery analysis", async () => {
  const { analyzeDiscovery } = await import("../src/analyze.ts");
  const analysis = await analyzeDiscovery({ mode: "repository", files: [source(code)] });
  assert.equal(analysis.signals.filter((s) => s.ruleId === "go-obs.metrics.planned-batch-as-executed").length, 1);
});
