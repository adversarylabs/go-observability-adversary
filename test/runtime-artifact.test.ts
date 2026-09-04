import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cancellationFixture = `package sample
import "context"
type Logger interface { Debugf(string, ...any); Errorf(string, ...any) }
type delivery struct{}
func (delivery) Nack(bool, bool) error { return nil }
type worker struct { logger Logger }
func (w *worker) listen(ctx context.Context, d delivery) {
  if err := w.handle(ctx, d); err != nil { w.logger.Errorf("handle failed: %v", err) }
}
func (w *worker) handle(ctx context.Context, d delivery) error {
  err := work(ctx)
  if err != nil {
    if ctx.Err() != nil { w.logger.Debugf("context done; skipping nack"); return err }
    _ = d.Nack(false, false)
  }
  return err
}
`;

const lossyClassificationFixture = `package sample
import (
  "context"
  "errors"
  "example.com/project/internal/log"
  "example.com/parser/manifest"
)
var ErrIsAnImage = errors.New("reference is an image")
func pull(ctx context.Context) { log.Infof(ctx, "pulling") }
func ensure(ctx context.Context, source []byte) error {
  parsed, err := manifest.ParseManifest(source)
  // Unable to parse the artifact manifest, assume an image.
  if err != nil { return ErrIsAnImage }
  _ = parsed
  return nil
}
`;

const successLatencyMetricFixture = `package metrics
// SchedulerFireLatencyPerDomainHistogram measures scheduler lag to StartWorkflow completion.
const SchedulerFireLatencyPerDomainHistogram = 42
`;

const successLatencyActivityFixture = `package scheduler
import (
  "time"
  "example.com/project/common/metrics"
)
func processFire(req Request) (*Result, error) {
  defer func() {
    metrics.ExponentialHistogram(metrics.SchedulerFireLatencyPerDomainHistogram, time.Since(req.ScheduledTime))
  }()
  if req.SkipNew { return &Result{Skipped: true}, nil }
  response, err := client.StartWorkflowExecution(req)
  if err != nil { return nil, err }
  return &Result{RunID: response.RunID}, nil
}
`;

const highCardinalityFixture = `package metrics
import "github.com/prometheus/client_golang/prometheus"
var docMarkers = []string{"example url", "documentation", "error page"}
var requests = prometheus.NewCounterVec(
  prometheus.CounterOpts{Name: "requests_total"},
  []string{"method", "request_id"},
)
`;

test("the published runtime executes without node_modules", async () => {
  const artifact = await mkdtemp(join(tmpdir(), "go-observability-artifact-"));
  const repository = await mkdtemp(join(tmpdir(), "go-observability-target-"));
  const lossyOnlyRepository = await mkdtemp(join(tmpdir(), "go-observability-lossy-target-"));
  const successLatencyRepository = await mkdtemp(join(tmpdir(), "go-observability-success-latency-target-"));
  const highCardinalityRepository = await mkdtemp(join(tmpdir(), "go-observability-cardinality-target-"));
  const entrypoint = join(artifact, "dist", "index.js");
  const input = join(artifact, "input.json");
  const output = join(artifact, "output.json");

  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(join(artifact, "schemas"), { recursive: true });
  await copyFile(join(projectRoot, "dist", "index.js"), entrypoint);
  await copyFile(join(projectRoot, "dist", "web-tree-sitter.wasm"), join(artifact, "dist", "web-tree-sitter.wasm"));
  await copyFile(join(projectRoot, "dist", "tree-sitter-go.wasm"), join(artifact, "dist", "tree-sitter-go.wasm"));
  await copyFile(
    join(projectRoot, "schemas", "adversary.review.v1.schema.json"),
    join(artifact, "schemas", "adversary.review.v1.schema.json"),
  );
  await copyFile(join(projectRoot, "THIRD_PARTY_NOTICES.md"), join(artifact, "THIRD_PARTY_NOTICES.md"));
  await writeFile(join(artifact, "package.json"), '{"type":"module"}\n');
  await writeFile(join(repository, "main.go"), cancellationFixture);
  await writeFile(join(repository, "classification.go"), lossyClassificationFixture);
  await writeFile(join(lossyOnlyRepository, "classification.go"), lossyClassificationFixture);
  await mkdir(join(successLatencyRepository, "common", "metrics"), { recursive: true });
  await mkdir(join(successLatencyRepository, "service", "scheduler"), { recursive: true });
  await writeFile(join(successLatencyRepository, "common", "metrics", "defs.go"), successLatencyMetricFixture);
  await writeFile(join(successLatencyRepository, "service", "scheduler", "activity.go"), successLatencyActivityFixture);
  await writeFile(join(highCardinalityRepository, "metrics.go"), highCardinalityFixture);
  await writeFile(input, `${JSON.stringify({ source: { path: repository } })}\n`);

  const bundle = await readFile(entrypoint, "utf8");
  assert.doesNotMatch(bundle, /from\s+["'](?:@adversarylabs\/sdk|web-tree-sitter)["']/);
  const notices = await readFile(join(artifact, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.deepEqual([...notices.matchAll(/^## (.+?) \(/gm)].map((match) => match[1]), [
    "@adversarylabs/sdk",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "tree-sitter-go",
    "web-tree-sitter",
    "yaml",
  ]);
  assert.match(notices, /Permission is hereby granted/);
  assert.match(notices, /Redistribution and use in source and binary forms/);
  assert.match(notices, /Copyright \(c\) 2014 Max Brunsfeld/);

  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: input,
      ADVERSARY_OUTPUT: output,
      ADVERSARY_REPO: repository,
    },
  });

  const envelope = JSON.parse(await readFile(output, "utf8"));
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(envelope.result.adversary.name, "go/observability");
  assert.equal(envelope.result.adversary.version, "0.0.14");
  assert.deepEqual(envelope.result.findings.map((finding: { ruleId: string }) => finding.ruleId), [
    "go-obs.logging.normal-cancellation-as-error",
    "go-obs.logging.lossy-parse-classification",
  ]);

  const lossyInput = join(artifact, "lossy-input.json");
  const lossyOutput = join(artifact, "lossy-output.json");
  await writeFile(lossyInput, `${JSON.stringify({ source: { path: lossyOnlyRepository } })}\n`);
  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: lossyInput,
      ADVERSARY_OUTPUT: lossyOutput,
      ADVERSARY_REPO: lossyOnlyRepository,
    },
  });
  const lossyEnvelope = JSON.parse(await readFile(lossyOutput, "utf8"));
  assert.deepEqual(lossyEnvelope.result.findings.map((finding: { ruleId: string; severity: string }) => ({
    ruleId: finding.ruleId,
    severity: finding.severity,
  })), [{ ruleId: "go-obs.logging.lossy-parse-classification", severity: "low" }]);
  assert.equal(lossyEnvelope.result.opinion.ship, true);

  const successLatencyInput = join(artifact, "success-latency-input.json");
  const successLatencyOutput = join(artifact, "success-latency-output.json");
  await writeFile(successLatencyInput, `${JSON.stringify({ source: { path: successLatencyRepository } })}\n`);
  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: successLatencyInput,
      ADVERSARY_OUTPUT: successLatencyOutput,
      ADVERSARY_REPO: successLatencyRepository,
    },
  });
  const successLatencyEnvelope = JSON.parse(await readFile(successLatencyOutput, "utf8"));
  assert.deepEqual(successLatencyEnvelope.result.findings.map((finding: { ruleId: string; severity: string }) => ({
    ruleId: finding.ruleId,
    severity: finding.severity,
  })), [{ ruleId: "go-obs.metrics.success-latency-on-non-success-paths", severity: "medium" }]);
  assert.equal(successLatencyEnvelope.result.opinion.ship, false);

  const highCardinalityInput = join(artifact, "high-cardinality-input.json");
  const highCardinalityOutput = join(artifact, "high-cardinality-output.json");
  await writeFile(highCardinalityInput, `${JSON.stringify({ source: { path: highCardinalityRepository } })}\n`);
  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: highCardinalityInput,
      ADVERSARY_OUTPUT: highCardinalityOutput,
      ADVERSARY_REPO: highCardinalityRepository,
    },
  });
  const highCardinalityEnvelope = JSON.parse(await readFile(highCardinalityOutput, "utf8"));
  assert.deepEqual(highCardinalityEnvelope.result.findings.map((finding: { ruleId: string; severity: string }) => ({
    ruleId: finding.ruleId,
    severity: finding.severity,
  })), [{ ruleId: "go-obs.metrics.high-cardinality", severity: "high" }]);
  assert.equal(highCardinalityEnvelope.result.findings[0].evidence.length, 1);
  assert.equal(highCardinalityEnvelope.result.opinion.ship, false);
});
