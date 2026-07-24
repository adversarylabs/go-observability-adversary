import { contentSignal, lineSignals, positive } from "./signals.js";
import { type DomainDefinition } from "./types.js";

export const domain: DomainDefinition = {
  name: "go-observability",
  displayName: "Go Observability",
  observationKey: "go-observability.analysis",
  sourceDescription: "Go telemetry",
  includePath: (path) => path.endsWith(".go") && !path.endsWith("_test.go"),
  rules: [
    {
      id: "go-observability.metric-cardinality",
      title: "A metric label has unbounded cardinality",
      category: "observability",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} metric label definition${count === 1 ? "" : "s"} include request- or user-specific values.`,
      whyItMatters: "Every unique label set creates a new time series in the metrics backend.",
      impact: "User IDs, URLs, and raw errors can make metrics expensive, slow, and eventually unusable.",
      recommendation: "Keep labels to bounded dimensions such as operation, method, status class, and stable outcome.",
    },
    {
      id: "go-observability.sensitive-log",
      title: "Telemetry records sensitive values",
      category: "security",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} log statement${count === 1 ? "" : "s"} include a credential or sensitive header.`,
      whyItMatters: "Telemetry is broadly accessible and commonly exported outside the service boundary.",
      impact: "Tokens or authorization values can be retained and exposed through logging infrastructure.",
      recommendation: "Drop sensitive values before logging and use a non-secret correlation identifier.",
    },
    {
      id: "go-observability.context-loss",
      title: "A trace starts from a new background context",
      category: "observability",
      severity: "medium",
      confidence: "high",
      summary: (count) => `${count} span${count === 1 ? "" : "s"} discard the caller's trace context.`,
      whyItMatters: "Trace parentage and baggage travel through context.",
      impact: "The operation appears as a disconnected trace, breaking end-to-end latency and error diagnosis.",
      recommendation: "Start spans from the request, command, or worker context that owns the operation.",
    },
  ],
  noRiskSummary: "The reviewed telemetry uses bounded dimensions, propagated context, and privacy-conscious values.",
  approvalSummary: "I would trust the reviewed telemetry for production diagnosis and reporting.",
  analyze(file) {
    return {
      signals: [
        ...lineSignals(
          file,
          "go-observability.metric-cardinality",
          /\[\]string\s*\{[^}]*(?:user_?id|url|path|error|email|request_?id)[^}]*\}/i,
          () => "This metric declares a request- or user-specific label dimension.",
        ),
        ...lineSignals(
          file,
          "go-observability.sensitive-log",
          /\b(?:slog|log|logger)\.(?:Info|Warn|Error|Debug|Printf?)\s*\([^)]*(?:token|password|authorization|cookie)/i,
          () => "This telemetry call includes a credential-like value.",
        ),
        ...contentSignal(
          file,
          "go-observability.context-loss",
          /\.Start\s*\(\s*context\.Background\s*\(\)/,
          "This span starts a new trace instead of continuing the owning context.",
        ),
      ],
      positives: [
        ...positive(file, "go-observability.flush-owned", /defer\s+\w+\.Shutdown\s*\(/, "Telemetry flushing is owned by process shutdown."),
        ...positive(file, "go-observability.context-propagated", /\.Start\s*\(\s*ctx\b/, "Trace context is propagated into the span."),
      ],
    };
  },
};
