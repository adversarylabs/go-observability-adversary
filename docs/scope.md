# go/observability — mission and scope

Source of truth for what this adversary is *for*.

- **Package:** `go-observability`
- **Factory routing:** human PR comments are attributed to this adversary only when they match **In scope**.
- **Languages / surfaces:** Go telemetry

## Mission

Review Go logs, traces, metrics, context propagation, and telemetry lifecycle.

## In scope (fair miss if humans raised it and we did not)

- Missing/broken context propagation for telemetry
- Metric/log/trace lifecycle defects
- High-cardinality or incorrect instrumentation in Go

## Out of scope (not a miss for this adversary)

- Generic eng without telemetry angle
- CI observability jobs

## Factory grading rule

- **In scope + human raised it + this adversary did not surface it** → real miss → suggested issue for **this** package
- **Out of scope** → do not grade as a miss for this adversary
- **Better fit for another adversary** → route there; do not double-count as a miss here
- **Unclear** → prefer out-of-scope for grading
