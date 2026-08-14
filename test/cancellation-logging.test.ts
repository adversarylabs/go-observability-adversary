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
      `if errpkg.Is(err, ctxpkg.Canceled) || errpkg.Is(err, ctxpkg.DeadlineExceeded) { return }
    r.logger.Errorf("error handling message: %v", err)`,
    );
  assert.deepEqual(await cancellationEscalationSignals([source(filtered)]), []);
});

test("matches cancellation-kind coverage and terminal caller control flow", async () => {
  const onlyCanceled = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { return }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  const onlyDeadline = onlyCanceled.replace("context.Canceled", "context.DeadlineExceeded");
  assert.equal((await cancellationEscalationSignals([source(onlyCanceled)])).length, 1);
  assert.equal((await cancellationEscalationSignals([source(onlyDeadline)])).length, 1);

  const separateCoverage = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { return }
    if errors.Is(err, context.DeadlineExceeded) { return }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(separateCoverage)]), []);

  const canceledOnlyCallee = dapr.replace(
    "if ctx.Err() != nil {",
    "if errors.Is(err, context.Canceled) {",
  );
  const canceledOnlyFilter = canceledOnlyCallee.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { return }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(canceledOnlyFilter)]), []);

  const gotoBeforeLogger = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) { goto logIt }
  logIt:
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.equal((await cancellationEscalationSignals([source(gotoBeforeLogger)])).length, 1);
});

test("tracks definitely invoked stored closure mutations before logging", async () => {
  const invoked = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `mutate := func() { err = errors.New("replacement") }
    mutate()
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(invoked)]), []);

  const uninvoked = invoked.replace("    mutate()\n", "    _ = mutate\n");
  assert.equal((await cancellationEscalationSignals([source(uninvoked)])).length, 1);

  const conditional = invoked.replace("    mutate()", "    if verbose { mutate() }")
    .replace("type rabbitMQ struct", "var verbose bool\ntype rabbitMQ struct");
  assert.equal((await cancellationEscalationSignals([source(conditional)])).length, 1);

  const conditionalMutation = invoked.replace(
    'func() { err = errors.New("replacement") }',
    'func() { if verbose { err = errors.New("replacement") } }',
  ).replace("type rabbitMQ struct", "var verbose bool\ntype rabbitMQ struct");
  assert.equal((await cancellationEscalationSignals([source(conditionalMutation)])).length, 1);

  const replaced = invoked.replace(
    "    mutate()",
    "    mutate = func() {}\n    mutate()",
  );
  assert.equal((await cancellationEscalationSignals([source(replaced)])).length, 1);
});

test("treats only an unshadowed imported os.Exit as terminal", async () => {
  const withOs = dapr.replace('"errors"', '"errors"\n  "os"');
  const exit = withOs.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) { os.Exit(0) }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(exit)]), []);

  const aliased = exit.replace('"os"', 'sys "os"').replace("os.Exit(0)", "sys.Exit(0)");
  assert.deepEqual(await cancellationEscalationSignals([source(aliased)]), []);

  const parenthesized = exit.replace("os.Exit(0)", "(os.Exit)(0)");
  assert.deepEqual(await cancellationEscalationSignals([source(parenthesized)]), []);

  const fake = withOs
    .replace("type rabbitMQ struct", "type fakeOS struct{}\nfunc (fakeOS) Exit(int) {}\n\ntype rabbitMQ struct")
    .replace(
      'r.logger.Errorf("error handling message: %v", err)',
      `os := fakeOS{}
    os.Exit(0)
    r.logger.Errorf("error handling message: %v", err)`,
    );
  assert.equal((await cancellationEscalationSignals([source(fake)])).length, 1);

  const siblingShadow = withOs
    .replace("type rabbitMQ struct", "type fakeOS struct{}\nfunc (fakeOS) Exit(int) {}\n\ntype rabbitMQ struct")
    .replace(
      'r.logger.Errorf("error handling message: %v", err)',
      `{ os := fakeOS{}; os.Exit(0) }
    os.Exit(1)
    r.logger.Errorf("error handling message: %v", err)`,
    );
  assert.deepEqual(await cancellationEscalationSignals([source(siblingShadow)]), []);

  const partialExit = withOs.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { os.Exit(0) }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.equal((await cancellationEscalationSignals([source(partialExit)])).length, 1);
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

test("supports combined cancellation classification and WithError logger chains", async () => {
  const combined = dapr.replace(
    "if ctx.Err() != nil {",
    "if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {",
  );
  assert.equal((await cancellationEscalationSignals([source(combined)])).length, 1);

  const chained = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    'r.logger.WithError(err).Errorf("error handling message")',
  );
  assert.equal((await cancellationEscalationSignals([source(chained)])).length, 1);

  const resultInFormatArgument = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    'r.logger.WithError(other).Errorf("error handling message: %v", err)',
  );
  assert.equal((await cancellationEscalationSignals([source(resultInFormatArgument)])).length, 1);
});

test("only accepts a dominating terminating caller cancellation filter", async () => {
  const nested = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if verbose {
      if errors.Is(err, context.Canceled) { return }
    }
    r.logger.Errorf("error handling message: %v", err)`,
  ).replace("type rabbitMQ struct { logger Logger }", "var verbose bool\ntype rabbitMQ struct { logger Logger }");
  assert.equal((await cancellationEscalationSignals([source(nested)])).length, 1);

  const observing = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { observeCancellation() }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.equal((await cancellationEscalationSignals([source(observing)])).length, 1);

  const dominated = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) { return }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(dominated)]), []);

  const locallyShadowedContext = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `context := struct{ Canceled error }{errors.New("local marker")}
    if errors.Is(err, context.Canceled) { return }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.equal((await cancellationEscalationSignals([source(locallyShadowedContext)])).length, 1);

  const shadowedPanic = dapr.replace(
    "func (r *rabbitMQ) listenMessages(ctx context.Context, d delivery) {",
    "func (r *rabbitMQ) listenMessages(ctx context.Context, d delivery) {\n  panic := func(any) {}",
  ).replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { panic(err) }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.equal((await cancellationEscalationSignals([source(shadowedPanic)])).length, 1);
});

test("requires real imported context and errors bindings for cancellation classification", async () => {
  const localContext = dapr.replace(
    "func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {",
    `func (r *rabbitMQ) handleMessage(ctx context.Context, d delivery) error {
  context := struct{ Canceled, DeadlineExceeded error }{errors.New("stop"), errors.New("deadline")}`,
  ).replace(
    "if ctx.Err() != nil {",
    "if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {",
  );
  assert.deepEqual(await cancellationEscalationSignals([source(localContext)]), []);

  const receiverErrors = dapr
    .replaceAll("func (r *rabbitMQ)", "func (errors *rabbitMQ)")
    .replaceAll("r.", "errors.")
    .replace(
      "if ctx.Err() != nil {",
      "if errors.Is(err, context.Canceled) {",
    );
  assert.deepEqual(await cancellationEscalationSignals([source(receiverErrors)]), []);
});

test("ignores unreachable loggers and field labels that only spell the result name", async () => {
  const unreachable = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `return
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(unreachable)]), []);

  const fieldLabel = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    'r.logger.Errorf("error handling message: %v", struct{ err error }{err: other}.err)',
  );
  assert.deepEqual(await cancellationEscalationSignals([source(fieldLabel)]), []);

  const evaluatedMapKey = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    'r.logger.Errorf("error handling message: %v", map[error]error{err: other})',
  );
  assert.equal((await cancellationEscalationSignals([source(evaluatedMapKey)])).length, 1);
});

test("binds the classified, returned, and logged error without shadow or reassignment", async () => {
  const shadowedReturn = dapr.replace(
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err`,
    `r.logger.Debugf("context done; cleanup failed")
      err := errors.New("cleanup failed")
      return err`,
  );
  const reassignedReturn = dapr.replace(
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err`,
    `r.logger.Debugf("context done; cleanup failed")
      err = cleanup()
      return err`,
  );
  const callerReassignment = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `err = cleanup()
    r.logger.Errorf("error handling message: %v", err)`,
  );
  const invokedReassignment = dapr.replace(
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err`,
    `r.logger.Debugf("context done; cleanup failed")
      func() { err = cleanup() }()
      return err`,
  );
  const nestedParameter = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    'r.logger.Errorf("error handling message: %v", func(err error) error { return err }(other))',
  );
  for (const current of [shadowedReturn, reassignedReturn, callerReassignment, invokedReassignment, nestedParameter]) {
    assert.deepEqual(await cancellationEscalationSignals([source(current)]), []);
  }

  const nestedParameterDoesNotRebindOuter = dapr.replace(
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err`,
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      func(err error) { _ = err }(other)
      return err`,
  );
  assert.equal((await cancellationEscalationSignals([source(nestedParameterDoesNotRebindOuter)])).length, 1);

  const identifierUsedInAssignmentTarget = dapr.replace(
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err`,
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      seen[err] = true
      return err`,
  );
  assert.equal((await cancellationEscalationSignals([source(identifierUsedInAssignmentTarget)])).length, 1);
});

test("multiline classification and logger operands anchor the exact changed semantic line", async () => {
  const classification = dapr.replace(
    "if ctx.Err() != nil {",
    `if errors.Is(
      err,
      context.Canceled,
    ) {`,
  );
  const classificationLine = classification.split("\n")
    .findIndex((line) => line.includes("context.Canceled")) + 1;
  const classificationSignals = await cancellationEscalationSignals([
    source(classification, new Set([classificationLine]), "modified"),
  ]);
  assert.equal(classificationSignals.length, 1);
  assert.equal(classificationSignals[0]?.line, classificationLine);

  const logger = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `r.logger.Errorf(
      "error handling message: %v",
      err,
    )`,
  );
  const loggerLine = logger.split("\n").findIndex((line) => line.trim() === "err,") + 1;
  const loggerSignals = await cancellationEscalationSignals([
    source(logger, new Set([loggerLine]), "modified"),
  ]);
  assert.equal(loggerSignals.length, 1);
  assert.equal(loggerSignals[0]?.line, loggerLine);

  const commentOnly = logger.replace('      "error handling message: %v",', '      // wording only\n      "error handling message: %v",');
  const commentLine = commentOnly.split("\n").findIndex((line) => line.includes("wording only")) + 1;
  assert.deepEqual(await cancellationEscalationSignals([
    source(commentOnly, new Set([commentLine]), "modified"),
  ]), []);
});

test("binds context and panic provenance, proves reachability, and compares prior semantics", async () => {
  const fakeContext = dapr
    .replace("type rabbitMQ struct", "type fakeContext struct{}\nfunc (fakeContext) Err() error { return errors.New(\"custom\") }\n\ntype rabbitMQ struct")
    .replace("if ctx.Err() != nil {", "ctx := fakeContext{}\n    if ctx.Err() != nil {");
  assert.deepEqual(await cancellationEscalationSignals([source(fakeContext)]), []);

  const ifInitFakeContext = dapr
    .replace("type rabbitMQ struct", "type fakeContext struct{}\nfunc (fakeContext) Err() error { return errors.New(\"custom\") }\n\ntype rabbitMQ struct")
    .replace("if ctx.Err() != nil {", "if ctx := (fakeContext{}); ctx.Err() != nil {");
  assert.deepEqual(await cancellationEscalationSignals([source(ifInitFakeContext)]), []);

  const reassignedContext = dapr.replace(
    "err := handle(ctx)",
    "ctx = context.Background()\n  err := handle(ctx)",
  );
  assert.equal((await cancellationEscalationSignals([source(reassignedContext)])).length, 1);

  const gotoLogger = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `goto handled
    r.logger.Errorf("error handling message: %v", err)
  handled:`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(gotoLogger)]), []);

  const packagePanic = dapr
    .replace("type rabbitMQ struct", "func panic(any) {}\n\ntype rabbitMQ struct")
    .replace(
      'r.logger.Errorf("error handling message: %v", err)',
      `if errors.Is(err, context.Canceled) { panic(err) }
    r.logger.Errorf("error handling message: %v", err)`,
    );
  assert.equal((await cancellationEscalationSignals([source(packagePanic)])).length, 1);

  const trailingPackagePanic = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `if errors.Is(err, context.Canceled) { panic(err) }
    r.logger.Errorf("error handling message: %v", err)`,
  ) + "\nfunc panic(any) {}\n";
  assert.equal((await cancellationEscalationSignals([source(trailingPackagePanic)])).length, 1);

  const unreachableIntent = dapr.replace(
    `r.logger.Debugf("context done; skipping ack/nack during shutdown")
      return err`,
    `return err
      r.logger.Debugf("context done; skipping ack/nack during shutdown")`,
  ).replace("    if err := d.Nack(false, false); err != nil { return err }", "    _ = d");
  assert.deepEqual(await cancellationEscalationSignals([source(unreachableIntent)]), []);

  const exhaustiveSwitch = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `switch {
    case errors.Is(err, context.Canceled): return
    default: return
    }
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.deepEqual(await cancellationEscalationSignals([source(exhaustiveSwitch)]), []);

  const incompleteSwitch = exhaustiveSwitch.replace("    default: return", "    default: observeCancellation()");
  assert.equal((await cancellationEscalationSignals([source(incompleteSwitch)])).length, 1);

  const reachableGotoLabel = dapr.replace(
    'r.logger.Errorf("error handling message: %v", err)',
    `goto handled
  handled:
    r.logger.Errorf("error handling message: %v", err)`,
  );
  assert.equal((await cancellationEscalationSignals([source(reachableGotoLabel)])).length, 1);

  const commentOnly = dapr.replace("if ctx.Err() != nil {", "if ctx.Err() != nil { // wording only");
  const commentLine = commentOnly.split("\n").findIndex((line) => line.includes("wording only")) + 1;
  assert.deepEqual(await cancellationEscalationSignals([{
    ...source(commentOnly, new Set([commentLine]), "modified"),
    previous: dapr,
  }]), []);

  const semanticAndComment = dapr.replace(
    "if ctx.Err() != nil {",
    "if errors.Is(err, context.Canceled) { // document the explicit class",
  );
  const semanticLine = semanticAndComment.split("\n").findIndex((line) => line.includes("explicit class")) + 1;
  const changed = await cancellationEscalationSignals([{
    ...source(semanticAndComment, new Set([semanticLine]), "modified"),
    previous: dapr,
  }]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.line, semanticLine);
});
