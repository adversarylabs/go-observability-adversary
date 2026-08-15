# Checks — what go-observability detects

This file is the **public audit list** of detectors for the **go-observability** adversary. High-confidence logging/metrics/tracing defects in Go services with file:line evidence — not a "you should add observability" nag machine. Absence-of-telemetry findings are banned; we flag telemetry that is *broken*.

Runtime source of truth: [`src/domain.ts`](src/domain.ts), with cross-file metric analysis in [`src/metric-units.ts`](src/metric-units.ts) and [`src/failure-rates.ts`](src/failure-rates.ts).

**Scope:** `*.go` excluding vendored trees. Focus on net/http, gRPC, slog/zap/zerolog/logrus, Prometheus client, and OpenTelemetry call sites.

**Precision stance:** No generic "add more metrics/logs/traces" findings — that is style. The narrow exception is an internally incomplete metric family, such as a failure numerator that cannot be interpreted without its operation total. Fire on telemetry defects that corrupt data, make the emitted signal unusable, or take down the telemetry stack itself. No Critical tier: observability defects cap at High.

Public grounding: Prometheus label-cardinality guidance ([instrumentation best practices](https://prometheus.io/docs/practices/instrumentation/)), OpenTelemetry Go span lifecycle docs, and the Go 1.21 vet slog analyzer.

---

## High

### `go-obs.metrics.duration-unit-mismatch`

| | |
| --- | --- |
| **What** | A Prometheus histogram or summary declares a duration unit in its metric name but records a different explicit Go duration unit |
| **Why** | A milliseconds-to-seconds mismatch shifts every sample by 1,000×; raw `time.Duration` values recorded into `_seconds` metrics shift them by 1,000,000,000× |
| **Looks for** | Package-local `NewHistogram`, `NewHistogramVec`, `NewSummary`, and `NewSummaryVec` collectors with `_seconds`, `_milliseconds`, `_microseconds`, or `_nanoseconds` names whose `Observe` call uses a different explicit conversion |
| **Stays quiet when** | The name and conversion agree; the collector name has no explicit duration unit; the observed expression's unit cannot be proven |
| **Public examples** | Human reviews in OffchainLabs/prysm#16733, grafana/mimir#911, and flipt-io/flipt#4673 questioned inconsistent or implicit metric duration units |
| **Remediation** | Convert the observation to the declared unit, normally with `Duration.Seconds()` for Prometheus duration metrics |

### `go-obs.metrics.high-cardinality`

| | |
| --- | --- |
| **What** | Unbounded user-controlled values used as Prometheus label values |
| **Why** | Label cardinality explosion is the canonical way to OOM a Prometheus server — every distinct value creates a new time series |
| **Looks for** | `WithLabelValues(...)` / `prometheus.Labels{...}` receiving `r.URL.Path`, user IDs, request IDs, error strings (`err.Error()`), or other unbounded variables |
| **Stays quiet when** | Label values come from a bounded enum/const set, route *templates* (`/users/{id}` via router route name, not the raw path), or status-code classes |
| **Public examples** | Prometheus docs: “do not use labels to store dimensions with high cardinality”; recurring cardinality-explosion postmortems |
| **Remediation** | Use route templates, bounded enums, and status classes as labels; put unbounded data in logs/traces, never metric labels |

### `go-obs.trace.span-not-ended`

| | |
| --- | --- |
| **What** | Span started but not ended on all return paths |
| **Why** | Unended spans leak memory, never export, and produce truncated traces — the trace *looks* like the request hung |
| **Looks for** | `ctx, span := tracer.Start(...)` without `defer span.End()` and with return paths missing `span.End()` |
| **Stays quiet when** | `defer span.End()` immediately follows Start; explicit span handoff (span passed onward with a documented owner) |
| **Public examples** | OpenTelemetry Go docs mandate `defer span.End()` as the first statement after Start |
| **Remediation** | `defer span.End()` on the line after `tracer.Start` |

### `go-obs.panic.recover-swallow`

| | |
| --- | --- |
| **What** | `recover()` discards the panic without logging or re-reporting it |
| **Why** | Silent panic swallowing turns crashes into invisible data corruption — the worst observability defect there is |
| **Looks for** | `defer` blocks calling `recover()` where the recovered value is ignored (`_ = recover()`, empty branch, no log/metric/error propagation) |
| **Stays quiet when** | Recovered value is logged with a stack, converted to an error return, counted in a metric, or re-panicked |
| **Public examples** | Widely documented Go anti-pattern; recover-and-log middleware is the correct contrast |
| **Remediation** | Log recovered value + `debug.Stack()`, increment a panic counter, and return an error — never a bare recover |

---

## Medium

### `go-obs.logging.normal-cancellation-as-error`

| | |
| --- | --- |
| **What** | A helper classifies context cancellation as normal shutdown but a direct caller logs the returned error at error level |
| **Why** | Graceful cancellation becomes a false production error, obscuring real failures and creating noisy alerts |
| **Looks for** | Same-file direct calls where a callee's explicit `ctx.Err()` or `errors.Is` branch for `context.Canceled`, `context.DeadlineExceeded`, or both suppresses lifecycle effects or emits debug/info shutdown telemetry, returns that same error binding, and the caller unconditionally passes the result directly or through `WithError(err)` to `Error`/`Errorf`/`Errorw` |
| **Stays quiet when** | A dominating caller guard terminates cancellation before the logger; the result is reassigned or shadowed; the caller only retries, reconnects, or propagates; the callee treats cancellation as exceptional; or resolution would require interfaces, cross-file types, or multiple call hops |
| **Public example** | Dapr components-contrib #4450 filtered `context.Canceled` and `context.DeadlineExceeded` before its parallel caller's error logger after review identified the remaining shutdown noise |
| **Remediation** | Preserve propagation when required, but classify normal cancellation before error-level telemetry |

### `go-obs.metrics.failure-without-denominator`

| | |
| --- | --- |
| **What** | A Prometheus failure/error counter has no comparable same-subject event total |
| **Why** | A raw failure count cannot distinguish isolated noise from a subsystem failing every operation when traffic varies |
| **Looks for** | Changed `NewCounter`/`NewCounterVec` definitions (including Cilium's metric wrapper) whose metric name contains `error`/`failure` but whose Go package has no same-subject attempts, operations, requests, or total counter |
| **Stays quiet when** | A comparable counter is present; the nearby metric is only an unrelated total or current-state gauge; the counter is a self-contained event such as process restarts rather than a failure numerator |
| **Public example** | A Cilium metrics review required `id_allocation_attempts_total` alongside `id_allocation_failures_total` so operators could calculate the allocation failure rate |
| **Remediation** | Add and increment a same-label attempts/operations counter for every operation represented by the failure metric |

### `go-obs.slog.args-mismatch`

| | |
| --- | --- |
| **What** | `slog` call with mismatched key/value pairs or non-string key |
| **Why** | Produces `!BADKEY` garbage in logs; the structured data you thought you captured is gone |
| **Looks for** | `slog.Info/Warn/Error/Debug` (and `Logger` methods) with an odd number of trailing args or non-string keys — vet-parity with the Go 1.21 slog analyzer |
| **Stays quiet when** | Pairs balance; `slog.Attr` / `slog.Group` forms used |
| **Public examples** | Go 1.21 added this exact vet check — implement as vet parity for zero FP |
| **Remediation** | Balance key/value pairs; prefer typed `slog.String/Int` attrs |

### `go-obs.trace.background-context`

| | |
| --- | --- |
| **What** | Span or downstream call started from `context.Background()` inside a request path that has a real context |
| **Why** | Breaks trace propagation — child spans land in a new orphan trace and cross-service correlation dies |
| **Looks for** | `tracer.Start(context.Background(), ...)` / instrumented outbound calls with `context.Background()` inside handlers or functions that receive a ctx |
| **Stays quiet when** | Intentional detached work after response (documented); code paths with no inbound context available |
| **Public examples** | OpenTelemetry context-propagation docs; orphan-trace debugging writeups |
| **Remediation** | Thread the request context; use `context.WithoutCancel` (Go 1.21+) for deliberate post-response work so the trace link survives |

### `go-obs.metrics.register-in-request`

| | |
| --- | --- |
| **What** | Metric registration inside a request handler or loop |
| **Why** | `MustRegister` of a duplicate collector panics — the second request kills the process; per-request `New*` also leaks |
| **Looks for** | `prometheus.MustRegister` / `promauto.New*` / `prometheus.New*Vec` lexically inside handler funcs or loops |
| **Stays quiet when** | Registration at package init / constructor, called once |
| **Public examples** | prometheus/client_golang docs — duplicate registration panics via MustRegister |
| **Remediation** | Register once at startup; pass collectors into handlers |

### `go-obs.otel.error-not-recorded`

| | |
| --- | --- |
| **What** | Function with an active span returns an error without marking the span |
| **Why** | Traces show green while the operation failed; error-rate-by-span queries lie |
| **Looks for** | LLM-gated: span in scope, `return err` paths with no `span.RecordError` / `span.SetStatus(codes.Error, …)` |
| **Stays quiet when** | Errors recorded; expected sentinel errors (`io.EOF` in streaming loops) explicitly not span-relevant |
| **Public examples** | OpenTelemetry Go error-handling conventions |
| **Remediation** | `span.RecordError(err); span.SetStatus(codes.Error, err.Error())` before returning |

---

## Out of scope (owned elsewhere)

| Concern | Owner |
| --- | --- |
| Logging secrets/tokens | `go/security` (`log.secrets`) |
| Logging full request headers | `go/http` (`header.untrusted-log`) |
| pprof/debug endpoint exposure | `go/security` (`pprof.exposed`) |
| `log.Fatal` outside main | `go/cli` (`exit.codes`) |
| Metrics endpoint auth | `go/http` (`metrics.unauth`) |

---

## Release gates (repo checklist)

- [ ] `npm test`
- [ ] `adversary validate .`
- [ ] `adversary pack --check .`
- [ ] Five graded fixture snapshots match
- [ ] Benchmark corpus contains 50–100 unique, reachable repositories
- [ ] Runtime artifact executes without `node_modules`
- [ ] No scanned repository writes or model calls
