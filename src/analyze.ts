import { domain } from "./domain.js";
import { cancellationEscalationSignals } from "./cancellation-logging.js";
import { failureCounterWithoutDenominatorSignals } from "./failure-rates.js";
import { highCardinalitySignals } from "./high-cardinality.js";
import { lossyErrorClassificationSignals } from "./lossy-error-classification.js";
import { metricDurationUnitMismatchSignals } from "./metric-units.js";
import { parseGo } from "./parser.js";
import { successLatencyOnNonSuccessPathSignals } from "./success-latency.js";
import { type Analysis, type Discovery, type PositiveSignal, type Signal, type SourceRevision } from "./types.js";

export async function analyzeDiscovery(discovery: Discovery): Promise<Analysis> {
  const signals: Signal[] = [];
  const positives: PositiveSignal[] = [];
  const parseErrors: Analysis["parseErrors"] = [];

  for (const file of discovery.files) {
    try {
      if (file.path.endsWith(".go")) {
        const tree = await parseGo(file.current);
        try {
          if (tree.rootNode.hasError) throw new Error("Go source contains syntax errors");
        } finally {
          tree.delete();
        }
      }
      const result = domain.analyze(file);
      signals.push(...result.signals.filter((item) => changed(file, item.line, item.endLine)));
      positives.push(...result.positives.filter((item) => changed(file, item.line)));
    } catch (error) {
      parseErrors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const fileByPath = new Map(discovery.files.map((file) => [file.path, file]));
  signals.push(...metricDurationUnitMismatchSignals(discovery.files).filter((item) => {
    const file = fileByPath.get(item.path);
    return file !== undefined && changed(file, item.line, item.endLine);
  }));
  signals.push(...await highCardinalitySignals(discovery.files));
  signals.push(...failureCounterWithoutDenominatorSignals(discovery.files).filter((item) => {
    const file = fileByPath.get(item.path);
    return file !== undefined && changed(file, item.line, item.endLine);
  }));
  signals.push(...await successLatencyOnNonSuccessPathSignals(discovery.files));
  signals.push(...await cancellationEscalationSignals(discovery.files));
  signals.push(...await lossyErrorClassificationSignals(discovery.files));

  return {
    mode: discovery.mode,
    ...(discovery.base === undefined ? {} : { base: discovery.base }),
    filesScanned: discovery.files.length,
    signals: signals.sort(byLocation),
    positives: positives.sort(byLocation),
    parseErrors: parseErrors.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function changed(file: SourceRevision, line: number, endLine = line): boolean {
  if (file.status === "repository" || file.status === "added") return true;
  for (let candidate = line; candidate <= endLine; candidate += 1) {
    if (file.changedLines.has(candidate)) return true;
  }
  return false;
}

function byLocation(left: { path: string; line: number }, right: { path: string; line: number }): number {
  return left.path.localeCompare(right.path) || left.line - right.line;
}
