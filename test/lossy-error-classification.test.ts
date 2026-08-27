import assert from "node:assert/strict";
import test from "node:test";
import { lossyErrorClassificationSignals } from "../src/lossy-error-classification.js";
import { type SourceRevision } from "../src/types.js";

const reviewed = `package ociartifact

import (
  "context"
  "errors"
  "github.com/cri-o/cri-o/internal/log"
  "go.podman.io/image/v5/manifest"
)

var ErrIsAnImage = errors.New("reference is a container image, not an OCI artifact")

type Store struct{}

func (s *Store) Pull(ctx context.Context) {
  log.Infof(ctx, "pulling artifact")
}

func (s *Store) EnsureNotContainerImage(ctx context.Context, manifestBytes []byte) error {
  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)
  // Unable to parse as OCI manifest (e.g. Docker v2 schema 2), assume an image
  if err != nil {
    return ErrIsAnImage
  }
  _ = ociManifest
  return nil
}
`;

function source(
  current: string,
  options: Partial<Pick<SourceRevision, "previous" | "status" | "changedLines">> = {},
): SourceRevision {
  return {
    path: "internal/ociartifact/store.go",
    current,
    status: options.status ?? "repository",
    changedLines: options.changedLines ?? new Set<number>(),
    ...(options.previous === undefined ? {} : { previous: options.previous }),
  };
}

test("flags the accepted CRI-O parser-to-sentinel diagnostic loss", async () => {
  const signals = await lossyErrorClassificationSignals([source(reviewed)]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.ruleId, "go-obs.logging.lossy-parse-classification");
  assert.equal(signals[0]?.data.parser, "manifest.OCI1FromManifest");
  assert.equal(signals[0]?.data.returnedSentinel, "ErrIsAnImage");
  assert.equal(signals[0]?.data.discardedError, "err");
  assert.match(signals[0]?.message ?? "", /discards the parser error/);
});

test("finds the immediate relationship inside a same-function classification guard", async () => {
  const nested = reviewed.replace(
    "  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
    "  if isImageMediaType(manifestBytes) {\n    ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
  ).replace("  _ = ociManifest", "    _ = ociManifest\n  }");
  const signals = await lossyErrorClassificationSignals([source(nested)]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.data.function, "EnsureNotContainerImage");
});

test("stays quiet for the accepted debug-log fix", async () => {
  const fixed = reviewed.replace(
    "    return ErrIsAnImage",
    '    log.Debugf(ctx, "Failed to parse OCI 1 manifest: %v", err)\n    return ErrIsAnImage',
  );
  assert.deepEqual(await lossyErrorClassificationSignals([source(fixed)]), []);
});

test("requires an imported external parser and its exact lexical binding", async () => {
  const localParser = reviewed
    .replace('  "go.podman.io/image/v5/manifest"\n', "")
    .replace("manifest.OCI1FromManifest", "parseManifest");
  const shadowedParser = reviewed.replace(
    "  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
    "  manifest := localManifestParser{}\n  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
  );
  assert.deepEqual(await lossyErrorClassificationSignals([source(localParser)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(shadowedParser)]), []);
});

test("requires a proven package sentinel constructed with standard errors.New", async () => {
  const localValue = reviewed.replace(
    'var ErrIsAnImage = errors.New("reference is a container image, not an OCI artifact")',
    'const ErrIsAnImage = "image"',
  );
  const customErrors = reviewed.replace('  "errors"', '  errors "example.com/project/errors"');
  assert.deepEqual(await lossyErrorClassificationSignals([source(localValue)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(customErrors)]), []);
});

test("requires an established imported context logger", async () => {
  const noLoggerCall = reviewed.replace('  log.Infof(ctx, "pulling artifact")', "  _ = ctx");
  const customLogger = reviewed.replace(
    '  "github.com/cri-o/cri-o/internal/log"',
    '  "example.com/project/diagnostics"',
  ).replaceAll("log.", "diagnostics.");
  const noContext = reviewed
    .replace('  "context"\n', "")
    .replaceAll("ctx context.Context", "ctx any");
  const deadLogger = reviewed.replace(
    '  log.Infof(ctx, "pulling artifact")',
    '  if false { log.Infof(ctx, "pulling artifact") }',
  );
  assert.deepEqual(await lossyErrorClassificationSignals([source(noLoggerCall)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(customLogger)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(noContext)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(deadLogger)]), []);
});

test("requires an immediate non-nil classification under an explicit fallback comment", async () => {
  const noComment = reviewed.replace(
    "  // Unable to parse as OCI manifest (e.g. Docker v2 schema 2), assume an image\n",
    "",
  );
  const unrelatedComment = reviewed.replace(
    "Unable to parse as OCI manifest (e.g. Docker v2 schema 2), assume an image",
    "Inspect the parser result",
  );
  const separated = reviewed.replace(
    "  // Unable to parse as OCI manifest",
    "  inspect(ociManifest)\n  // Unable to parse as OCI manifest",
  );
  const classified = reviewed.replace("if err != nil {", "if errors.Is(err, ErrMalformed) {");
  assert.deepEqual(await lossyErrorClassificationSignals([source(noComment)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(unrelatedComment)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(separated)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(classified)]), []);
});

test("does not generalize to arbitrary failures or returned causes", async () => {
  const arbitrary = reviewed.replace("manifest.OCI1FromManifest", "manifest.Fetch");
  const propagated = reviewed.replace("return ErrIsAnImage", "return err");
  const wrapped = reviewed.replace("return ErrIsAnImage", 'return fmt.Errorf("parse manifest: %w", err)');
  assert.deepEqual(await lossyErrorClassificationSignals([source(arbitrary)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(propagated)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(wrapped)]), []);
});

test("rejects unreachable parser relationships and shadowed context bindings", async () => {
  const deadBlock = reviewed
    .replace(
      "  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
      "  if false {\n    ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
    )
    .replace("  _ = ociManifest", "    _ = ociManifest\n  }");
  const afterReturn = reviewed.replace(
    "  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
    "  return nil\n  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
  );
  const shadowedContext = reviewed
    .replace(
      "  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
      "  if enabled() {\n    ctx := fakeContext{}\n    ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
    )
    .replace("  _ = ociManifest", "    _ = ociManifest\n  }");
  const afterBuiltinPanic = reviewed.replace(
    "  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)",
    '  panic("stop")\n  ociManifest, err := manifest.OCI1FromManifest(manifestBytes)',
  );
  const localPanic = afterBuiltinPanic.replace(
    "func (s *Store) EnsureNotContainerImage(ctx context.Context, manifestBytes []byte) error {",
    "func (s *Store) EnsureNotContainerImage(ctx context.Context, manifestBytes []byte) error {\n  panic := func(any) {}",
  );
  const packagePanic = afterBuiltinPanic.replace(
    "type Store struct{}",
    "type Store struct{}\nfunc panic(any) {}",
  );
  const siblingPanicShadow = afterBuiltinPanic.replace(
    '  panic("stop")',
    '  { panic := func(any) {}; _ = panic }\n  panic("stop")',
  );
  const packagePanicValue = afterBuiltinPanic.replace(
    "type Store struct{}",
    "type Store struct{}\nvar panic = func(any) {}",
  );
  assert.deepEqual(await lossyErrorClassificationSignals([source(deadBlock)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(afterReturn)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(shadowedContext)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(afterBuiltinPanic)]), []);
  assert.deepEqual(await lossyErrorClassificationSignals([source(siblingPanicShadow)]), []);
  assert.equal((await lossyErrorClassificationSignals([source(localPanic)])).length, 1);
  assert.equal((await lossyErrorClassificationSignals([source(packagePanic)])).length, 1);
  assert.equal((await lossyErrorClassificationSignals([source(packagePanicValue)])).length, 1);
});

test("binds aliases for context, errors, parser, and logger imports", async () => {
  const aliased = reviewed
    .replace('  "context"', '  ctxpkg "context"')
    .replace('  "errors"', '  errpkg "errors"')
    .replace('  "github.com/cri-o/cri-o/internal/log"', '  telemetry "github.com/cri-o/cri-o/internal/log"')
    .replace('  "go.podman.io/image/v5/manifest"', '  imageManifest "go.podman.io/image/v5/manifest"')
    .replaceAll("context.Context", "ctxpkg.Context")
    .replaceAll("errors.New", "errpkg.New")
    .replaceAll("log.", "telemetry.")
    .replaceAll("manifest.OCI1FromManifest", "imageManifest.OCI1FromManifest");
  const signals = await lossyErrorClassificationSignals([source(aliased)]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.data.logger, "telemetry");
  assert.equal(signals[0]?.data.parser, "imageManifest.OCI1FromManifest");
});

test("requires changed semantic evidence and keeps legacy or comment-only paths quiet", async () => {
  const callLine = reviewed.split("\n").findIndex((line) => line.includes("OCI1FromManifest")) + 1;
  const added = reviewed.replace("manifestBytes)", "updatedManifestBytes)");
  assert.equal((await lossyErrorClassificationSignals([
    source(added, { previous: reviewed.replace("manifestBytes)", "oldManifestBytes)"), status: "modified", changedLines: new Set([callLine]) }),
  ])).length, 0, "the same pre-existing lossy relationship remains legacy despite an argument edit");

  const introduced = reviewed.replace("manifest.OCI1FromManifest", "manifest.ParseManifest");
  const introducedLine = introduced.split("\n").findIndex((line) => line.includes("ParseManifest")) + 1;
  const signals = await lossyErrorClassificationSignals([
    source(introduced, { previous: reviewed.replace("manifest.OCI1FromManifest", "manifest.Fetch"), status: "modified", changedLines: new Set([introducedLine]) }),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.line, introducedLine);

  const commentOnly = reviewed.replace("assume an image", "conservatively assume an image");
  const commentLine = commentOnly.split("\n").findIndex((line) => line.includes("conservatively")) + 1;
  assert.deepEqual(await lossyErrorClassificationSignals([
    source(commentOnly, { previous: reviewed, status: "modified", changedLines: new Set([commentLine]) }),
  ]), []);

  const unrelated = reviewed.replace("type Store struct{}", "type Store struct{ name string }");
  const unrelatedLine = unrelated.split("\n").findIndex((line) => line.includes("name string")) + 1;
  assert.deepEqual(await lossyErrorClassificationSignals([
    source(unrelated, { previous: reviewed, status: "modified", changedLines: new Set([unrelatedLine]) }),
  ]), []);

  const duplicate = reviewed.replace(
    "  _ = ociManifest",
    `  _ = ociManifest
  anotherManifest, err := manifest.OCI1FromManifest(manifestBytes)
  // Unable to parse this alternate manifest, assume an image.
  if err != nil { return ErrIsAnImage }
  _ = anotherManifest`,
  );
  const duplicateLine = duplicate.split("\n").findIndex((line) => line.includes("anotherManifest, err")) + 1;
  const duplicateSignals = await lossyErrorClassificationSignals([
    source(duplicate, { previous: reviewed, status: "modified", changedLines: new Set([duplicateLine]) }),
  ]);
  assert.equal(duplicateSignals.length, 1, "a second newly introduced equivalent relationship is not hidden by legacy evidence");
  assert.equal(duplicateSignals[0]?.line, duplicateLine);
});

test("ignores test files", async () => {
  assert.deepEqual(await lossyErrorClassificationSignals([{ ...source(reviewed), path: "store_test.go" }]), []);
});
