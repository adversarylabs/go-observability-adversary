## What we want to improve

Catch failure-only metric families that cannot answer the operational question they imply. A counter such as `id_allocation_failures_total` needs a comparable count of allocation attempts; without it, operators cannot distinguish an isolated failure from a subsystem that is failing every request.

This is not a general request to add more telemetry. It applies only when changed Go instrumentation defines a failure/error counter whose natural success population is measurable, but the reviewed metric family has no same-scope attempts, requests, operations, or total counter.

## Examples

- Flag `id_allocation_failures_total` when there is no `id_allocation_attempts_total` (or equivalent allocation total).
- Flag `request_errors_total` when there is no comparable `requests_total`.
- Stay quiet when numerator and denominator are defined together, including when they are split across changed files in the same Go package.
- Stay quiet for self-contained event counters such as `process_restarts_total` or `disk_corruption_incidents_total`; those are useful absolute counts and do not claim to represent a failure rate.

## Precision requirements

- Match Prometheus counter definitions, including the local wrapper shapes already used by projects such as Cilium.
- Pair metrics by their operation subject, not merely by finding any `_total` counter nearby. A connection-attempt counter does not explain allocation failures.
- Treat only counters as comparable event totals. A current-state gauge such as `active_requests` is not a denominator for historical failures.
- Prefer silence when the operation subject cannot be identified confidently.
- Point the finding at the failure-counter definition and recommend a same-label, same-scope attempts/operations counter.

## Done when

- [ ] A Cilium-style `id_allocation_failures_total` definition without allocation attempts is reported.
- [ ] `request_errors_total` without `requests_total` is reported.
- [ ] Same-subject attempts/total counters suppress the finding across one or multiple changed package files.
- [ ] Unrelated totals, gauges, and context-free event counters do not create or suppress findings incorrectly.
- [ ] Focused vulnerable and clean fixtures cover the rule, and the five graded snapshots remain unchanged.

<!-- adversary-train-source: package=go-observability result=d7f3fcac run=slice-1786465434795758000 -->

<!-- adversary-train-key:ccf89704 -->
