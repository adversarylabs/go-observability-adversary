import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { metricDurationUnitMismatchSignals } from "../src/metric-units.ts";
import { type SourceRevision } from "../src/types.ts";

function source(path: string, current: string): SourceRevision {
  return { path, current, changedLines: new Set<number>(), status: "added" };
}

test("reports an explicit seconds metric observed as milliseconds across package files", () => {
  const signals = metricDurationUnitMismatchSignals([
    source("server/metrics.go", `package server

var requestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
    Name: "api_request_duration_seconds",
    Help: "Request latency in seconds.",
}, []string{"method"})
`),
    source("server/handler.go", `package server

func record(start time.Time) {
    requestDuration.WithLabelValues("GET").Observe(float64(time.Since(start).Milliseconds()))
}
`),
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.ruleId, "go-obs.metrics.duration-unit-mismatch");
  assert.deepEqual(signals[0]?.data, {
    metric: "api_request_duration_seconds",
    declaredUnit: "seconds",
    observedUnit: "milliseconds",
  });
  assert.equal(signals[0]?.path, "server/handler.go");
  assert.equal(signals[0]?.line, 4);
});

test("reports raw time.Duration nanoseconds recorded into a seconds metric", () => {
  const signals = metricDurationUnitMismatchSignals([
    source("metrics.go", `package service

var latency = promauto.NewSummary(prometheus.SummaryOpts{Name: "work_duration_seconds"})

func record(start time.Time) {
    latency.Observe(float64(time.Since(start)))
}
`),
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.data.observedUnit, "nanoseconds");
});

test("stays quiet for matching and unprovable units", () => {
  const signals = metricDurationUnitMismatchSignals([
    source("metrics.go", `package service

var seconds = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "work_duration_seconds"})
var millis = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "queue_duration_milliseconds"})
var unspecified = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "queue_latency"})
var indirect = prometheus.NewHistogram(sharedOptions)

func record(elapsed time.Duration, custom float64) {
    seconds.Observe(elapsed.Seconds())
    millis.Observe(float64(elapsed.Milliseconds()))
    unspecified.Observe(float64(elapsed.Milliseconds()))
    indirect.Observe(float64(elapsed.Milliseconds()))
    seconds.Observe(custom)
}
`),
  ]);

  assert.deepEqual(signals, []);
});

test("does not join same-named collectors across Go package directories", () => {
  const signals = metricDurationUnitMismatchSignals([
    source("one/metrics.go", `package one
var duration = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "one_duration_seconds"})
`),
    source("two/worker.go", `package two
func record(elapsed time.Duration) { duration.Observe(float64(elapsed.Milliseconds())) }
`),
  ]);

  assert.deepEqual(signals, []);
});

test("duration unit mismatches flow through discovery analysis", async () => {
  const files = [source("service/metrics.go", `package service
import (
    "time"
    "github.com/prometheus/client_golang/prometheus"
)
var latency = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "service_duration_seconds"})
func record(start time.Time) { latency.Observe(float64(time.Since(start).Milliseconds())) }
`)];

  const analysis = await analyzeDiscovery({ mode: "diff", files });
  assert.equal(
    analysis.signals.filter((signal) => signal.ruleId === "go-obs.metrics.duration-unit-mismatch").length,
    1,
  );
});
