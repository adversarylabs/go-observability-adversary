# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-obs.logging.normal-cancellation-as-error` | Medium | A helper classifies context cancellation as normal shutdown but a direct caller logs the returned error at error level |
| `go-obs.metrics.duration-unit-mismatch` | High | A Prometheus histogram or summary declares a duration unit in its metric name but records a different explicit Go duration unit |
| `go-obs.metrics.failure-without-denominator` | Medium | A Prometheus failure/error counter has no comparable same-subject event total |
| `go-obs.metrics.high-cardinality` | High | Unbounded user-controlled values used as Prometheus label values |
| `go-obs.metrics.register-in-request` | Medium | Metric registration inside a request handler or loop |
| `go-obs.panic.recover-swallow` | High | `recover()` discards the panic without logging or re-reporting it |
| `go-obs.slog.args-mismatch` | Medium | `slog` call with mismatched key/value pairs or non-string key |
| `go-obs.trace.background-context` | Medium | Span or downstream call started from `context.Background()` inside a request path that has a real context |
| `go-obs.trace.span-not-ended` | High | Span started but not ended on all return paths |
