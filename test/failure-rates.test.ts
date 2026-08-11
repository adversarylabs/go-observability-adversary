import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { failureCounterWithoutDenominatorSignals } from "../src/failure-rates.ts";
import { type SourceRevision } from "../src/types.ts";

function source(path: string, current: string): SourceRevision {
  return { path, current, changedLines: new Set<number>(), status: "added" };
}

async function fixture(path: string): Promise<SourceRevision> {
  return source(path, await readFile(new URL(`../fixtures/failure-only-metrics/${path}`, import.meta.url), "utf8"));
}

test("reports a Cilium-style allocation failure counter without attempts", async () => {
  const signals = failureCounterWithoutDenominatorSignals([
    await fixture("vulnerable/metrics.go"),
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.ruleId, "go-obs.metrics.failure-without-denominator");
  assert.equal(signals[0]?.path, "vulnerable/metrics.go");
  assert.deepEqual(signals[0]?.data, {
    metric: "id_allocation_failures_total",
    subject: "id_allocation",
  });
});

test("accepts a same-package request total and ignores gauges and absolute events", async () => {
  const signals = failureCounterWithoutDenominatorSignals([
    await fixture("clean/cilium.go"),
    await fixture("clean/metrics.go"),
    await fixture("clean/totals.go"),
  ]);

  assert.deepEqual(signals, []);
});

test("an unrelated total does not suppress allocation failures", () => {
  const signals = failureCounterWithoutDenominatorSignals([
    source("metrics.go", `package service
var failures = prometheus.NewCounter(prometheus.CounterOpts{Name: "allocation_failures_total"})
var attempts = prometheus.NewCounter(prometheus.CounterOpts{Name: "connection_attempts_total"})
`),
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.data.metric, "allocation_failures_total");
});

test("a gauge is not treated as a historical request denominator", () => {
  const signals = failureCounterWithoutDenominatorSignals([
    source("metrics.go", `package service
var failures = prometheus.NewCounter(prometheus.CounterOpts{Name: "request_failures_total"})
var active = prometheus.NewGauge(prometheus.GaugeOpts{Name: "active_requests"})
`),
  ]);

  assert.equal(signals.length, 1);
});

test("failure-only metric signals flow through discovery analysis", async () => {
  const files = [await fixture("vulnerable/metrics.go")];
  const analysis = await analyzeDiscovery({ mode: "diff", files });
  assert.equal(
    analysis.signals.filter((signal) => signal.ruleId === "go-obs.metrics.failure-without-denominator").length,
    1,
  );
});
