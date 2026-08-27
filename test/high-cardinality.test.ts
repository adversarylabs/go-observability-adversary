import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDiscovery } from "../src/analyze.js";
import { type SourceRevision } from "../src/types.js";

const prometheusImport = `import "github.com/prometheus/client_golang/prometheus"`;

function source(
  current: string,
  options: Partial<Pick<SourceRevision, "previous" | "status" | "changedLines">> = {},
): SourceRevision {
  return {
    path: "metrics.go",
    current,
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    status: options.status ?? "repository",
    changedLines: options.changedLines ?? new Set<number>(),
  };
}

async function findings(file: SourceRevision) {
  const analysis = await analyzeDiscovery({ mode: "diff", files: [file] });
  assert.deepEqual(analysis.parseErrors, []);
  return analysis.signals.filter((signal) => signal.ruleId === "go-obs.metrics.high-cardinality");
}

test("ordinary string slices containing path, URL, or error words are quiet", async () => {
  const current = `package review

var docMarkers = []string{".. class::", "placeholder", "example url", "readme", "documentation", "docstring"}
var routeParts = []string{"path", "error page"}
`;
  assert.equal((await findings(source(current))).length, 0);
});

test("reports direct and proven-variable Prometheus vector label names", async () => {
  const current = `package metrics

${prometheusImport}

var requestLabels = []string{"method", "request_id"}
var direct = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "direct_total"}, []string{"user_id"})
var indirect = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "latency_seconds"}, requestLabels)
`;
  const got = await findings(source(current));
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((signal) => signal.data.boundary), [
    "prometheus-vector-label-names",
    "prometheus-vector-label-names",
  ]);
});

test("requires exact Prometheus constructor provenance", async () => {
  const current = `package review

import "fmt"

type fakeMetrics struct{}
func (fakeMetrics) NewCounterVec(any, []string) int { return 0 }
var fake fakeMetrics
var labels = []string{"request_id"}
var value = fake.NewCounterVec(nil, labels)

func explain() {
  fmt.Println("prometheus.NewCounterVec(opts, []string{\\\"user_id\\\"})")
}
`;
  assert.equal((await findings(source(current))).length, 0);
});

test("supports promauto aliases and rejects locally shadowed import aliases", async () => {
  const current = `package metrics

import auto "github.com/prometheus/client_golang/prometheus/promauto"

var real = auto.NewCounterVec(prometheus.CounterOpts{Name: "requests_total"}, []string{"path"})

func shadowed() {
  auto := fakeFactory{}
  _ = auto.NewCounterVec(nil, []string{"user_id"})
}
`;
  const got = await findings(source(current));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.data.boundary, "prometheus-vector-label-names");
});

test("reports syntactic unbounded label values but not bounded string literals", async () => {
  const current = `package metrics

func observe(metric interface{ WithLabelValues(...string) }, r *Request, userID string) {
  metric.WithLabelValues(r.URL.Path, userID)
  metric.WithLabelValues("userID", "GET")
}

type Request struct { URL *URL }
type URL struct { Path string }
`;
  const got = await findings(source(current));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.data.boundary, "with-label-values");
});

test("reports imported prometheus.Labels maps and ignores unrelated Labels types", async () => {
  const current = `package metrics

import prom "github.com/prometheus/client_golang/prometheus"

type Labels map[string]string
var real = prom.Labels{"request_id": requestID}
var unrelated = Labels{"request_id": requestID}
var requestID string
`;
  const got = await findings(source(current));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.data.boundary, "prometheus-labels-map");
});

test("unrelated edits do not revive unchanged legacy metric dimensions", async () => {
  const previous = `package metrics

${prometheusImport}

var requests = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "requests_total"}, []string{"path"})
var note = "old"
`;
  const current = previous.replace(`var note = "old"`, `var note = "new"`);
  const changedLine = current.slice(0, current.indexOf(`var note`)).split("\n").length;
  assert.equal((await findings(source(current, {
    previous,
    status: "modified",
    changedLines: new Set([changedLine]),
  }))).length, 0);
});

test("changed label and newly proven constructor provenance report at changed evidence", async () => {
  const bounded = `package metrics

${prometheusImport}

var requests = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "requests_total"}, []string{"method"})
`;
  const unbounded = bounded.replace(`"method"`, `"path"`);
  const labelLine = unbounded.slice(0, unbounded.indexOf(`"path"`)).split("\n").length;
  const changedLabel = await findings(source(unbounded, {
    previous: bounded,
    status: "modified",
    changedLines: new Set([labelLine]),
  }));
  assert.equal(changedLabel.length, 1);
  assert.equal(changedLabel[0]!.line, labelLine);

  const unknown = unbounded.replace("prometheus.NewCounterVec", "factory.NewCounterVec");
  const constructorLine = unbounded.slice(0, unbounded.indexOf("prometheus.NewCounterVec")).split("\n").length;
  const proven = await findings(source(unbounded, {
    previous: unknown,
    status: "modified",
    changedLines: new Set([constructorLine]),
  }));
  assert.equal(proven.length, 1);
  assert.equal(proven[0]!.line, constructorLine);

  const wrongImport = unbounded.replace(prometheusImport, `import "example.com/fake/prometheus"`);
  const importLine = unbounded.slice(0, unbounded.indexOf(prometheusImport)).split("\n").length;
  const provenByImport = await findings(source(unbounded, {
    previous: wrongImport,
    status: "modified",
    changedLines: new Set([importLine]),
  }));
  assert.equal(provenByImport.length, 1);
  assert.equal(provenByImport[0]!.line, importLine);
});
