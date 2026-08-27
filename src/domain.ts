import { contentSignal, lineSignals, positive } from "./signals.js";
import { type DomainDefinition, type Signal, type SourceRevision } from "./types.js";

export const domain: DomainDefinition = {
  // Catalog / package identity uses domain/name taxonomy.
  name: "go/observability",
  displayName: "Go Observability",
  observationKey: "go-observability.analysis",
  sourceDescription: "Go telemetry",
  includePath: (path) => path.endsWith(".go") && !path.endsWith("_test.go"),
  rules: [
    {
      id: "go-obs.logging.lossy-parse-classification",
      title: "A parser failure is collapsed into a sentinel without diagnostics",
      category: "observability",
      severity: "low",
      confidence: "high",
      summary: (count) =>
        `${count} changed parser failure path${count === 1 ? " discards" : "s discard"} the original cause while returning a classification sentinel.`,
      whyItMatters:
        "A deliberate fallback can share one parser error path with malformed or otherwise unexpected input; collapsing both into a sentinel removes the only evidence that distinguishes them.",
      impact:
        "Operators can see the fallback classification but cannot diagnose why parsing failed or distinguish expected alternate formats from corrupted input.",
      recommendation:
        "Log the original parser error at debug level immediately before returning the sentinel, or retain the cause in the returned error when the caller contract allows it.",
    },
    {
      id: "go-obs.logging.normal-cancellation-as-error",
      title: "Normal cancellation is re-logged as an error",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} normal cancellation path${count === 1 ? " is" : "s are"} re-escalated to error-level telemetry by a direct caller.`,
      whyItMatters:
        "Graceful shutdown is an expected lifecycle event; logging it as an error creates false incidents and trains operators to ignore real failures.",
      impact:
        "Shutdowns emit spurious error events even though the callee deliberately suppressed operational failure handling for cancellation.",
      recommendation:
        "Keep returning the cancellation error when the contract requires it, but filter context.Canceled and context.DeadlineExceeded before the caller's error-level logger.",
    },
    {
      id: "go-obs.metrics.failure-without-denominator",
      title: "A failure counter has no comparable event total",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        count === 1
          ? "1 failure counter lacks a same-subject attempts or total counter."
          : `${count} failure counters lack a same-subject attempts or total counter.`,
      whyItMatters:
        "A failure count without the population that produced it cannot distinguish isolated noise from a subsystem failing every operation.",
      impact:
        "Dashboards and alerts cannot compute a failure rate, so the new metric does not answer whether the system is healthy.",
      recommendation:
        "Add a same-label counter for total attempts or operations in the same metric family and increment it on every attempt.",
    },
    {
      id: "go-obs.metrics.duration-unit-mismatch",
      title: "A duration metric records a different unit than it declares",
      category: "observability",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} duration metric observation${count === 1 ? "" : "s"} disagree with the declared unit.`,
      whyItMatters:
        "Metric names are the unit contract for dashboards and histogram buckets; recording another scale silently corrupts every query.",
      impact: "Latency panels, alerts, and quantiles are wrong by factors of thousands or billions.",
      recommendation:
        "Convert the observed duration to the unit named by the metric, normally seconds for Prometheus durations.",
    },
    {
      id: "go-obs.metrics.success-latency-on-non-success-paths",
      title: "A success-latency distribution includes skipped outcomes",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} success-latency metric${count === 1 ? " is" : "s are"} deferred across proven non-success return paths.`,
      whyItMatters:
        "Latency histograms define which population their quantiles describe; mixing skipped work into a successful-completion distribution changes that population.",
      impact:
        "Dashboards overstate or distort completion latency, and p95/p99 no longer describe successful operations when skip volume changes.",
      recommendation:
        "Emit the latency observation only after the named completion succeeds, or attach a bounded outcome dimension and filter dashboards by outcome.",
    },
    {
      id: "go-obs.metrics.high-cardinality",
      title: "A metric label has unbounded cardinality",
      category: "observability",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} metric label site${count === 1 ? "" : "s"} use request- or user-specific values.`,
      whyItMatters:
        "Every unique label set creates a new time series; user IDs, raw paths, and error strings explode cardinality.",
      impact: "Metrics backends OOM or become unqueryable under real traffic.",
      recommendation:
        "Use route templates, bounded enums, and status classes as labels; put unbounded data in logs/traces.",
    },
    {
      id: "go-obs.trace.span-not-ended",
      title: "A span is started without End on all return paths",
      category: "observability",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} span start${count === 1 ? "" : "s"} lack a deferred End in the owning scope.`,
      whyItMatters: "Unended spans leak memory, never export, and produce truncated traces.",
      impact: "Traces look hung and exporters retain unfinished spans until process death.",
      recommendation: "Call `defer span.End()` on the line after `tracer.Start`.",
    },
    {
      id: "go-obs.panic.recover-swallow",
      title: "recover discards a panic without logging or re-reporting",
      category: "observability",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} recover site${count === 1 ? "" : "s"} swallow panics without telemetry.`,
      whyItMatters:
        "Silent panic swallowing turns crashes into invisible data corruption — the worst observability defect.",
      impact: "Production failures leave no log, metric, or trace signal.",
      recommendation:
        "Log the recovered value with a stack, increment a panic counter, and return an error — never a bare recover.",
    },
    {
      id: "go-obs.slog.args-mismatch",
      title: "slog call has mismatched key/value pairs",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} slog call${count === 1 ? "" : "s"} have unbalanced or non-string keys.`,
      whyItMatters: "Odd key/value pairs produce `!BADKEY` garbage; structured fields are lost.",
      impact: "Log queries that depend on those fields silently miss production events.",
      recommendation: "Balance key/value pairs or prefer typed `slog.String` / `slog.Int` attrs.",
    },
    {
      id: "go-obs.trace.background-context",
      title: "A span starts from context.Background inside a real request path",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} span start${count === 1 ? "" : "s"} discard the caller's trace context.`,
      whyItMatters: "Trace parentage and baggage travel through context.",
      impact: "Child spans land in orphan traces and cross-service correlation dies.",
      recommendation:
        "Thread the request context; use `context.WithoutCancel` for deliberate post-response work.",
    },
    {
      id: "go-obs.metrics.register-in-request",
      title: "Metrics are registered inside a request path or loop",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} metric registration${count === 1 ? "" : "s"} run on a request or loop path.`,
      whyItMatters: "Duplicate MustRegister panics; per-request New* collectors leak series.",
      impact: "The second request can kill the process; memory grows without bound.",
      recommendation: "Register collectors once at startup and pass them into handlers.",
    },
  ],
  noRiskSummary:
    "The reviewed telemetry uses bounded dimensions, ended spans, and propagated context.",
  approvalSummary: "I would trust the reviewed telemetry for production diagnosis and reporting.",
  analyze(file) {
    return {
      signals: [
        ...spanNotEndedSignals(file),
        ...recoverSwallowSignals(file),
        ...slogArgsMismatchSignals(file),
        ...lineSignals(
          file,
          "go-obs.trace.background-context",
          /\.Start\s*\(\s*context\.Background\s*\(\)/,
          () => "This span starts a new trace instead of continuing the owning context.",
        ),
        ...registerInRequestSignals(file),
      ],
      positives: [
        ...positive(
          file,
          "go-obs.span-ended",
          /\bdefer\s+\w+\.End\s*\(/,
          "Span End is deferred immediately after Start.",
        ),
        ...positive(
          file,
          "go-obs.context-propagated",
          /\.Start\s*\(\s*ctx\b/,
          "Trace context is propagated into the span.",
        ),
        ...positive(
          file,
          "go-obs.flush-owned",
          /defer\s+\w+\.Shutdown\s*\(/,
          "Telemetry flushing is owned by process shutdown.",
        ),
      ],
    };
  },
};

/**
 * OpenTelemetry-style `ctx, span := tracer.Start(...)` without `defer span.End()`
 * in the same function scope.
 */
function spanNotEndedSignals(file: SourceRevision): Signal[] {
  const source = file.current;
  const assignRe =
    /\b(?:[A-Za-z_]\w*|\_)\s*,\s*([A-Za-z_]\w*)\s*:?=\s*[^\n;]*?\.Start\s*\(/g;
  const signals: Signal[] = [];
  let match: RegExpExecArray | null;
  while ((match = assignRe.exec(source)) !== null) {
    const spanVar = match[1] ?? "";
    if (spanVar === "" || spanVar === "_") continue;
    // Avoid non-trace Start methods that don't look span-like when End never expected:
    // still require that Start takes a context-ish first arg nearby.
    const call = match[0] ?? "";
    if (!/\.Start\s*\(/.test(call)) continue;
    if (hasDeferredSpanEnd(source, match.index ?? 0, spanVar)) continue;
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    signals.push({
      ruleId: "go-obs.trace.span-not-ended",
      path: file.path,
      line,
      message: `Span "${spanVar}" is started without a deferred End in this function.`,
      snippet: call.trim().slice(0, 300),
      data: { variable: spanVar },
    });
  }
  return signals;
}

function hasDeferredSpanEnd(source: string, assignIndex: number, spanVar: string): boolean {
  const rest = source.slice(assignIndex);
  const nextFunc = rest.search(/\nfunc\s+/);
  const scope = nextFunc === -1 ? rest : rest.slice(0, nextFunc);
  const escaped = spanVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\bdefer\\s+${escaped}\\.End\\s*\\(`).test(scope)) return true;
  if (
    new RegExp(
      `\\bdefer\\s+func\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,200}?\\b${escaped}\\.End\\s*\\(`,
    ).test(scope)
  ) {
    return true;
  }
  return false;
}

/**
 * recover() that ignores the value without logging / re-panic nearby.
 */
function recoverSwallowSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const source = file.current;
  // defer func() { ... recover() ... }()
  const deferRecover =
    /\bdefer\s+func\s*\([^)]*\)\s*\{([\s\S]{0,400}?)\}(?:\s*\(\s*\))?/g;
  let match: RegExpExecArray | null;
  while ((match = deferRecover.exec(source)) !== null) {
    const body = match[1] ?? "";
    if (!/\brecover\s*\(/.test(body)) continue;
    const reports =
      /\b(?:log|slog|logger|fmt)\.\w+\s*\(/.test(body) ||
      /\.Error\s*\(/.test(body) ||
      /\bpanic\s*\(/.test(body) ||
      /\bRecordError\b|\bInc\s*\(/.test(body) ||
      /\bdebug\.Stack\s*\(/.test(body);
    if (reports) continue;
    // Bare recover / _ = recover / if recover() != nil { } empty-ish
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    signals.push({
      ruleId: "go-obs.panic.recover-swallow",
      path: file.path,
      line,
      message: "This recover discards the panic without logging or re-reporting it.",
      snippet: (match[0] ?? "").trim().slice(0, 300),
      data: {},
    });
  }
  // Same-line bare patterns outside multi-line capture.
  signals.push(
    ...lineSignals(
      file,
      "go-obs.panic.recover-swallow",
      /(?:_|\w+)\s*=\s*recover\s*\(\s*\)\s*$/,
      () => "recover result is discarded without telemetry.",
    ).filter((s) => {
      // Skip if the line also logs.
      const lineText = file.current.split("\n")[s.line - 1] ?? "";
      return !/\b(?:log|slog|logger|fmt)\./.test(lineText);
    }),
  );
  // Dedup by line.
  const seen = new Set<number>();
  return signals.filter((s) => {
    if (seen.has(s.line)) return false;
    seen.add(s.line);
    return true;
  });
}

/**
 * Lightweight slog key/value balance check (vet-adjacent, high precision only).
 */
function slogArgsMismatchSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const re =
    /\b(?:slog\.(?:Info|Warn|Error|Debug|InfoContext|WarnContext|ErrorContext|DebugContext)|(?:\w+)\.(?:Info|Warn|Error|Debug)Context)\s*\(([^;]*)\)/g;
  // Line-oriented: slog.X("msg", ...) on one line.
  file.current.split("\n").forEach((line, index) => {
    const call = line.match(
      /\bslog\.(?:Info|Warn|Error|Debug)(?:Context)?\s*\((.*)\)\s*$/,
    );
    if (call === null) return;
    const argsSrc = call[1] ?? "";
    // Prefer Attr forms — quiet.
    if (/\bslog\.(?:String|Int|Int64|Bool|Any|Group|Attr)\s*\(/.test(argsSrc)) return;
    const args = splitTopLevelArgs(argsSrc);
    if (args.length === 0) return;
    // First arg is message (or ctx for *Context).
    let start = 1;
    if (/Context\s*\(/.test(line)) start = 2; // ctx, msg, kvs...
    const kvs = args.slice(start);
    if (kvs.length === 0) return;
    if (kvs.length % 2 !== 0) {
      signals.push({
        ruleId: "go-obs.slog.args-mismatch",
        path: file.path,
        line: index + 1,
        message: "slog call has an odd number of key/value arguments.",
        snippet: line.trim().slice(0, 300),
        data: { trailingArgs: kvs.length },
      });
      return;
    }
    // Non-string keys: numeric / bare ident that is not a string literal.
    for (let i = 0; i < kvs.length; i += 2) {
      const key = (kvs[i] ?? "").trim();
      if (key === "") continue;
      if (/^["`]/.test(key)) continue;
      if (/^slog\./.test(key)) continue;
      signals.push({
        ruleId: "go-obs.slog.args-mismatch",
        path: file.path,
        line: index + 1,
        message: "slog key is not a string literal (may produce !BADKEY).",
        snippet: line.trim().slice(0, 300),
        data: { key },
      });
      break;
    }
  });
  void re;
  return signals;
}

function splitTopLevelArgs(src: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let inStr: '"' | "'" | "`" | null = null;
  let escape = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inStr !== null) {
      current += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

/**
 * prometheus.MustRegister / promauto.New* / New*Vec inside non-init functions.
 */
function registerInRequestSignals(file: SourceRevision): Signal[] {
  if (
    !/\b(?:MustRegister|promauto\.New|prometheus\.New\w*Vec)\b/.test(file.current)
  ) {
    return [];
  }
  const signals: Signal[] = [];
  const lines = file.current.split("\n");
  let inFunc: string | null = null;
  let braceDepth = 0;
  let funcBraceBase = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const funcMatch = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)?\s*\(/);
    if (funcMatch && inFunc === null) {
      inFunc = funcMatch[1] ?? "literal";
      // brace opens on this or following lines
      funcBraceBase = braceDepth;
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;

    if (
      inFunc !== null &&
      inFunc !== "init" &&
      /\b(?:prometheus\.)?MustRegister\s*\(|\bpromauto\.New\w*\s*\(|\bprometheus\.New\w*Vec\s*\(/.test(
        line,
      )
    ) {
      signals.push({
        ruleId: "go-obs.metrics.register-in-request",
        path: file.path,
        line: i + 1,
        message: `Metric registration runs inside function ${inFunc}, not at package init.`,
        snippet: line.trim().slice(0, 300),
        data: { function: inFunc },
      });
    }

    if (inFunc !== null && braceDepth <= funcBraceBase && closes > 0 && opens === 0) {
      // Function may still be open if braces on same line as func — handle when depth returns.
    }
    if (inFunc !== null && braceDepth <= 0) {
      inFunc = null;
      braceDepth = 0;
    }
  }
  return signals;
}
