# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-obs.logging.lossy-parse-classification` | Low | Changed external parser failures immediately collapsed into a package sentinel under an explicit fallback/classification contract while the established context logger discards the original cause |
| `go-obs.logging.normal-cancellation-as-error` | Medium | A helper classifies context cancellation as normal shutdown but a direct caller logs the returned error at error level |
| `go-obs.metrics.duration-unit-mismatch` | High | A Prometheus histogram or summary declares a duration unit in its metric name but records a different explicit Go duration unit |
| `go-obs.metrics.failure-without-denominator` | Medium | A Prometheus failure/error counter has no comparable same-subject event total |
| `go-obs.metrics.high-cardinality` | High | Unbounded user-controlled values used as Prometheus label values |
| `go-obs.metrics.register-in-request` | Medium | Metric registration inside a request handler or loop |
| `go-obs.panic.recover-swallow` | High | `recover()` discards the panic without logging or re-reporting it |
| `go-obs.slog.args-mismatch` | Medium | `slog` call with mismatched key/value pairs or non-string key |
| `go-obs.trace.background-context` | Medium | Span or downstream call started from `context.Background()` inside a request path that has a real context |
| `go-obs.trace.span-not-ended` | High | Span started but not ended on all return paths |

The lossy parser-classification check is intentionally not a generic request for more logging. It requires one changed, immediate relationship: an imported parser returns an error; an explicit fallback/classification comment explains why the branch maps failure to a package-level `errors.New` sentinel; a real `context.Context` and an already-used imported logger prove the local diagnostic convention; and the original error is discarded. It stays quiet for local or shadowed parsers, arbitrary failing calls, returned/wrapped causes, branches with diagnostics, missing logger/context proof, tests, unchanged legacy relationships, unrelated diffs, and comment-only edits. Deletion-only changes without a current semantic anchor fail closed.
