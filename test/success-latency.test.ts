import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { successLatencyOnNonSuccessPathSignals } from "../src/success-latency.ts";
import { type SourceRevision } from "../src/types.ts";

function source(path: string, current: string, previous?: string, changedLines: number[] = []): SourceRevision {
  return previous === undefined
    ? { path, current, changedLines: new Set(changedLines), status: "added" }
    : { path, current, previous, changedLines: new Set(changedLines), status: "modified" };
}

const metricContract = source("common/metrics/defs.go", `package metrics
// SchedulerFireLatencyPerDomainHistogram measures end-to-end latency from scheduled time to StartWorkflow completion.
const SchedulerFireLatencyPerDomainHistogram = 42
`);

const vulnerable = `package scheduler
import (
  "time"
  "example.com/project/common/metrics"
)
func processFire(req Request) (*Result, error) {
  scope := metrics.Scope(req.Domain)
  defer func() {
    if req.Scheduled { scope.ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime)) }
  }()
  if req.SkipNew {
    scope.IncCounter(metrics.SchedulerFireSkippedCountPerDomain)
    return &Result{Skipped: true}, nil
  }
  response, err := client.StartWorkflowExecution(req)
  if err != nil { return nil, err }
  return &Result{RunID: response.RunID}, nil
}
`;

test("reports a Cadence-shaped success latency deferred across skipped outcomes", async () => {
  const signals = await successLatencyOnNonSuccessPathSignals([
    metricContract,
    source("service/worker/scheduler/activity.go", vulnerable),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.ruleId, "go-obs.metrics.success-latency-on-non-success-paths");
  assert.deepEqual(signals[0]?.data, {
    function: "processFire",
    metric: "SchedulerFireLatencyPerDomainHistogram",
    completionOperation: "StartWorkflow",
    scope: "same-function-deferred-success-latency",
  });
});

test("accepts emission after successful completion and outcome-tagged deferred latency", async () => {
  const afterSuccess = vulnerable.replace(
    /  defer func\(\) \{[\s\S]*?  \}\(\)\n/,
    "",
  ).replace(
    "  return &Result{RunID: response.RunID}, nil",
    "  scope.ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime))\n  return &Result{RunID: response.RunID}, nil",
  );
  const tagged = vulnerable.replace(
    "scope.ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime))",
    "scope.Tagged(metrics.OutcomeTag(outcome)).ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime))",
  );
  assert.deepEqual(await successLatencyOnNonSuccessPathSignals([
    metricContract,
    source("after.go", afterSuccess),
    source("tagged.go", tagged),
  ]), []);
});

test("stays quiet without a success contract, named completion call, or non-success return", async () => {
  const allOutcomeContract = source("all/metrics.go", `package metrics
// SchedulerFireLatencyPerDomainHistogram measures activity duration for every outcome.
const SchedulerFireLatencyPerDomainHistogram = 42
`);
  const unrelatedCompletion = vulnerable.replace("StartWorkflowExecution", "Run");
  const noSkip = vulnerable.replace(/  if req\.SkipNew \{[\s\S]*?  \}\n/, "");
  assert.deepEqual(await successLatencyOnNonSuccessPathSignals([
    allOutcomeContract,
    source("all/activity.go", vulnerable.replace("example.com/project/common/metrics", "example.com/project/all")),
    metricContract,
    source("unrelated.go", unrelatedCompletion),
    source("no-skip.go", noSkip),
  ]), []);
});

test("ignores error-only deferred telemetry and statically dead skip paths", async () => {
  const errorOnly = vulnerable.replace(
    "scope.ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime))",
    "scope.IncCounter(metrics.SchedulerFireErrorCountPerDomain)",
  );
  const deadSkip = vulnerable.replace("if req.SkipNew", "if false");
  const commentOnlySkip = vulnerable.replace(
    /  if req\.SkipNew \{[\s\S]*?  \}\n/,
    "  // skipped requests are handled by another worker\n  if err := validate(req); err != nil { return nil, err }\n",
  );
  assert.deepEqual(await successLatencyOnNonSuccessPathSignals([
    metricContract,
    source("error.go", errorOnly),
    source("dead.go", deadSkip),
    source("comment.go", commentOnlySkip),
  ]), []);
});

test("requires a changed semantic relationship and anchors the changed defer", async () => {
  const commentOnly = vulnerable.replace("scope :=", "scope := // documentation\n    ");
  const previousWithoutLatency = vulnerable.replace(
    "scope.ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime))",
    "scope.IncCounter(metrics.SchedulerFireErrorCountPerDomain)",
  );
  const quiet = await successLatencyOnNonSuccessPathSignals([
    metricContract,
    source("quiet.go", commentOnly, vulnerable, [7]),
  ]);
  assert.deepEqual(quiet, []);

  const report = await successLatencyOnNonSuccessPathSignals([
    metricContract,
    source("changed.go", vulnerable, previousWithoutLatency, [9]),
  ]);
  assert.equal(report.length, 1);
  assert.equal(report[0]?.line, 9);
});

test("success-latency signals flow through discovery analysis", async () => {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    files: [metricContract, source("service/worker/scheduler/activity.go", vulnerable)],
  });
  assert.equal(
    analysis.signals.filter((signal) => signal.ruleId === "go-obs.metrics.success-latency-on-non-success-paths").length,
    1,
  );
});
