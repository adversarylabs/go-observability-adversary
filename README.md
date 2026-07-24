# Go Observability adversary

Go Observability reviews whether logs, traces, metrics, and exporters can explain production behavior safely and reliably.

The initial review covers unbounded metric cardinality, sensitive telemetry, lost trace context, and factual positives for propagated contexts and owned shutdown.

## Fixtures and calibration

Five graded fixtures own expected review snapshots. The 61-repository corpus calibrates telemetry and context-propagation judgment.

## Automatic detection

`adversary auto` selects Go Observability for changed Go source. Runtime semantic detection will later narrow selection to instrumented boundaries.

## Development

Run `npm test`, `adversary validate .`, and `adversary pack --check .`.
