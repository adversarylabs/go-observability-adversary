# Train draft d7f3fcac

- **Package:** `go-observability`
- **Kind:** draft — Draft improvement — suggested package change from one or more misses.
- **Title:** Detect failure-only metrics missing a denominator
- **Summary:** Detect failure-only metrics missing a denominator
- **Run:** `slice-1786465434795758000`

_Applied by `adversary train results apply`. Synthetic draft — do not bank summary into `agent/voice.md`._

## What we want to improve

Flag diffs that introduce failure/error counters without a corresponding total/attempts metric in the same changed files so operators can compute meaningful failure rates from the changed instrumentation. Example domains include HTTP servers (request_errors_total vs requests_total) and clients or subsystems that track connection or allocation failures.

## Why this matters

Telemetry that records only failure counts without a matching denominator prevents computing failure rates and therefore cannot distinguish rare noise from systemic regressions. Detecting this in head-side changes ensures the instrumentation change includes a usable denominator or an explicit equivalent within the same changed files.

## Examples

- HTTP server: the diff adds a Prometheus counter named request_errors_total but the same changed files do not add requests_total, so error rates per endpoint are not computable.
- Database client: the diff adds db_connection_failures or connection_failures_total without adding connection_attempts or connections_total in the same changed files, leaving failure counts ambiguous under varying traffic.

## Keep it focused

- Adding process_restarts_total as a global restart counter should not be flagged because no denominator is meaningful.
- Adding request_errors_total and requests_total together in the same changed files should not be flagged because the denominator is present.

## Done when

- [ ] Flag when the head-side diff adds a new Prometheus counter whose name or symbol contains "error", "fail", "failed", or "failures" and the same changed files add no corresponding total/attempts metric for the same noun.
- [ ] Do not flag when the head-side diff adds both a failure counter and a same-scoped total or attempts metric in the same changed files.
- [ ] Do not flag when the head-side diff adds an absolute-event counter whose semantics are context-free, for example process_restarts_total or disk_corruption_incidents_total.
- [ ] Consider an alternative same-scoped signal such as an active_requests gauge or requests_total added in the same files as an acceptable denominator and do not raise a warning.
