import assert from "node:assert/strict";
import test from "node:test";
import { cancellationEscalationSignals } from "../src/cancellation-logging.js";
import { type SourceRevision } from "../src/types.js";

const dapr = `package rabbitmq

import (
  "context"
  "errors"
)

type rabbitMQ struct { logger Logger }
type Logger interface {
  Debugf(string, ...any)
  Errorf(string, ...any)
}
type delivery struct{}
func (delivery) Nack(bool, bool) error { return nil }

func (r *rabbitMQ) listenMessages(ctx context.Context, d delivery) {
  if err := r.handleMessage(ctx, d); err != nil {
    r.logger.Errorf("error handling message: %v", err)
  }
}

func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {
  err := handle(ctx)
  if err != nil {
    if ctx.Err() != nil {
      r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err
    }
    if err := d.Nack(false, false); err != nil { return err }
  }
  return err
}
`;

function source(current: string, changedLines = new Set<number>(), status: SourceRevision["status"] = "repository"): SourceRevision {
  return { path: "rabbitmq.go", current, changedLines, status };
}

test("flags Dapr's normal-cancellation return consumed by an unconditional error logger", async () => {
  const signals = await cancellationEscalationSignals([source(dapr)]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.ruleId, "go-obs.logging.normal-cancellation-as-error");
  assert.equal(signals[0]?.data.helper, "handleMessage");
  assert.equal(signals[0]?.data.caller, "listenMessages");
  assert.match(signals[0]?.snippet ?? "", /Errorf/);
});

test("resolves an immediately invoked goroutine closure but not a stored callback", async () => {
  const invoked = dapr.replace(
    `if err := r.handleMessage(ctx, d); err != nil {
    r.logger.Errorf("error handling message: %v", err)
  }`,
    `go func(d delivery) {
    if err := r.handleMessage(ctx, d); err != nil {
      r.logger.Errorf("error handling message: %v", err)
    }
  }(d)`,
  );
  assert.equal((await cancellationEscalationSignals([source(invoked)])).length, 1);

  const stored = invoked.replace("go func(d delivery)", "work := func(d delivery)").replace("}(d)\n}", "}\n  _ = work\n}");
  assert.deepEqual(await cancellationEscalationSignals([source(stored)]), []);
});

test("stays quiet when the caller filters normal cancellation before error logging", async () => {
  const filtered = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
      r.logger.Errorf("error handling message: %v", err)
    }`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(filtered)]), []);
});

test("stays quiet for propagation, retry, reconnect, and exceptional cancellation contracts", async () => {
  const propagation = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    "return",
  );
  const retry = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    "r.reconnect()",
  ).replace("type rabbitMQ struct { logger Logger }", "type rabbitMQ struct { logger Logger }\nfunc (r *rabbitMQ) reconnect() {} ");
  const exceptional = dapr.replace(
    'r.logger.Debugf("context done; skipping ack/nack during shutdown")',
    'r.logger.Errorf("cancellation violates the delivery contract")',
  );
  assert.deepEqual(await cancellationEscalationSignals([source(propagation)]), []);
  assert.deepEqual(await cancellationEscalationSignals([source(retry)]), []);
  assert.deepEqual(await cancellationEscalationSignals([source(exceptional)]), []);
});

test("recognizes effect suppression without requiring a particular shutdown message", async () => {
  const noDebug = dapr.replace(
    'r.logger.Debugf("context done; skipping ack/nack during shutdown")\n      ',
    "",
  );
  assert.equal((await cancellationEscalationSignals([source(noDebug)])).length, 1);
});

test("supports aliased context/errors and direct plain-function calls", async () => {
  const aliased = dapr
    .replace('"context"', 'ctxpkg "context"')
    .replace('"errors"', 'errpkg "errors"')
    .replaceAll("context.Context", "ctxpkg.Context")
    .replaceAll("context.Canceled", "ctxpkg.Canceled")
    .replaceAll("context.DeadlineExceeded", "ctxpkg.DeadlineExceeded")
    .replaceAll("errors.Is", "errpkg.Is");
  assert.equal((await cancellationEscalationSignals([source(aliased)])).length, 1);

  const plain = dapr
    .replaceAll("func (r *rabbitMQ) listenMessages", "func listenMessages")
    .replace("r.handleMessage(ctx, d)", "handleMessage(ctx, d)")
    .replaceAll("func (r *rabbitMQ) handleMessage", "func handleMessage")
    .replaceAll("r.logger.Debugf", "logger.Debugf")
    .replaceAll("r.logger.Errorf", "logger.Errorf")
    .replace("type rabbitMQ struct { logger Logger }", "var logger Logger");
  assert.equal((await cancellationEscalationSignals([source(plain)])).length, 1);
});

test("requires changed semantic evidence and ignores comment-only locality", async () => {
  const lines = dapr.split("\n");
  const cancellationLine = lines.findIndex((line) => line.includes("ctx.Err")) + 1;
  const loggerLine = lines.findIndex((line) => line.includes("error handling message")) + 1;
  const changedCancellation = await cancellationEscalationSignals([
    source(dapr, new Set([cancellationLine]), "modified"),
  ]);
  assert.equal(changedCancellation.length, 1);
  assert.equal(changedCancellation[0]?.line, cancellationLine);

  const changedLogger = await cancellationEscalationSignals([
    source(dapr, new Set([loggerLine]), "modified"),
  ]);
  assert.equal(changedLogger.length, 1);
  assert.equal(changedLogger[0]?.line, loggerLine);

  const withComment = dapr.replace("func (r *rabbitMQ) listenMessages", "// wording only\nfunc (r *rabbitMQ) listenMessages");
  const commentLine = withComment.split("\n").findIndex((line) => line.includes("wording only")) + 1;
  assert.deepEqual(await cancellationEscalationSignals([
    source(withComment, new Set([commentLine]), "modified"),
  ]), []);
});

test("does not resolve interface, cross-file, or multi-hop calls", async () => {
  const callerOnly = `package rabbitmq
import "context"
type rabbitMQ struct { logger Logger }
type Logger interface { Errorf(string, ...any) }
type delivery struct{}
func (r *rabbitMQ) listenMessages(ctx context.Context, d delivery) {
  if err := r.handleMessage(ctx, d); err != nil { r.logger.Errorf("failed: %v", err) }
}`;
  const helperOnly = `package rabbitmq
import "context"
type rabbitMQ struct { logger Logger }
type Logger interface { Debugf(string, ...any) }
type delivery struct{}
func (delivery) Nack(bool, bool) error { return nil }
func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {
  err := handle(ctx)
  if err != nil {
    if ctx.Err() != nil { r.logger.Debugf("context done; skipping nack"); return err }
    _ = d.Nack(false, false)
  }
  return err
}`;
  assert.deepEqual(await cancellationEscalationSignals([
    { ...source(callerOnly), path: "caller.go" },
    { ...source(helperOnly), path: "helper.go" },
  ]), []);
});

test("rejects separated result assignments and locally shadowed callees or receivers", async () => {
  const separated = dapr.replace(
    `if err := r.handleMessage(ctx, d); err != nil {
    r.logger.Errorf("error handling message: %v", err)
  }`,
    `err := r.handleMessage(ctx, d)
  if err != nil { r.logger.Errorf("error handling message: %v", err) }`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(separated)]), []);

  const shadowedPlain = dapr
    .replaceAll("func (r *rabbitMQ) listenMessages", "func listenMessages")
    .replace("r.handleMessage(ctx, d)", "handleMessage(ctx, d)")
    .replaceAll("func (r *rabbitMQ) handleMessage", "func handleMessage")
    .replaceAll("r.logger.Debugf", "logger.Debugf")
    .replaceAll("r.logger.Errorf", "logger.Errorf")
    .replace("type rabbitMQ struct { logger Logger }", "var logger Logger")
    .replace(
      "func listenMessages(ctx context.Context, d delivery) {",
      "func listenMessages(ctx context.Context, d delivery) {\n  handleMessage := func(context.Context, delivery) error { return nil }",
    );
  assert.deepEqual(await cancellationEscalationSignals([source(shadowedPlain)]), []);

  const shadowedReceiver = `package rabbitmq
import "context"
type Logger interface { Debugf(string, ...any); Errorf(string, ...any) }
type delivery struct{}
func (delivery) Nack(bool, bool) error { return nil }
type rabbitMQ struct { logger Logger }
type otherRabbit struct { logger Logger }
func (r *otherRabbit) handleMessage(context.Context, delivery) error { return nil }
func (r *rabbitMQ) listenMessages(ctx context.Context, d delivery) {
  {
    r := &otherRabbit{logger: r.logger}
    if err := r.handleMessage(ctx, d); err != nil { r.logger.Errorf("failed: %v", err) }
  }
}
func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {
  err := handle(ctx)
  if err != nil {
    if ctx.Err() != nil { r.logger.Debugf("context done; skipping nack"); return err }
    _ = d.Nack(false, false)
  }
  return err
}`;
  assert.deepEqual(await cancellationEscalationSignals([source(shadowedReceiver)]), []);
});

test("does not mistake imported error constructors for logger sinks", async () => {
  const constructor = dapr
    .replace('"errors"', '"errors"\n  "fmt"')
    .replace('r.logger.Errorf("error handling message: %v", err)', 'fmt.Errorf("error handling message: %v", err)');
  assert.deepEqual(await cancellationEscalationSignals([source(constructor)]), []);

  const reporter = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    'r.reporter.Errorf("error handling message: %v", err)',
  ).replace("type rabbitMQ struct { logger Logger }", "type rabbitMQ struct { logger Logger; reporter Reporter }\ntype Reporter interface { Errorf(string, ...any) }");
  assert.deepEqual(await cancellationEscalationSignals([source(reporter)]), []);
});

test("stays quiet when an aliased cancellation filter dominates a direct logger", async () => {
  const filtered = dapr
    .replace('"context"', 'ctxpkg "context"')
    .replace('"errors"', 'errpkg "errors"')
    .replaceAll("context.Context", "ctxpkg.Context")
    .replace(
      'r.logger.Errorf("error handling message: %v", err)',
      `if errpkg.Is(err, ctxpkg.Canceled) { return }
    r.logger.Errorf("error handling message: %v", err)`,
    );
  assert.deepEqual(await cancellationEscalationSignals([source(filtered)]), []);
});

test("recognizes explicit errors.Is cancellation classification in the callee", async () => {
  const classified = dapr.replace(
    `if err != nil {
    if ctx.Err() != nil {
      r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err
    }`,
    `if err != nil {
    if errors.Is(err, context.Canceled) {
      r.logger.Debugf("canceled during shutdown")
      return err
    }`,
  );
  assert.equal((await cancellationEscalationSignals([source(classified)])).length, 1);

  const shadowed = classified.replace(
    "func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {",
    `func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {
  errors := struct{ Is func(error, error) bool }{Is: func(error, error) bool { return true }}`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(shadowed)]), []);
});
