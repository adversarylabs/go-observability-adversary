import { type Signal, type SourceRevision } from "./types.js";

type DurationUnit = "seconds" | "milliseconds" | "microseconds" | "nanoseconds";

interface MetricDefinition {
  path: string;
  variable: string;
  metricName: string;
  unit: DurationUnit;
}

/**
 * Find duration collectors whose declared metric-name unit disagrees with the
 * unit passed to Observe. Both sides must be explicit; unknown/custom
 * collectors remain quiet.
 */
export function metricDurationUnitMismatchSignals(files: SourceRevision[]): Signal[] {
  const definitions = new Map<string, MetricDefinition[]>();
  for (const file of files) {
    const directory = metricDirectory(file.path);
    const packageDefinitions = definitions.get(directory) ?? [];
    for (const definition of metricDefinitions(file.current)) {
      packageDefinitions.push({ ...definition, path: file.path });
    }
    definitions.set(directory, packageDefinitions);
  }

  const signals: Signal[] = [];
  for (const file of files) {
    const byVariable = new Map<string, MetricDefinition[]>();
    for (const definition of definitions.get(metricDirectory(file.path)) ?? []) {
      const candidates = byVariable.get(definition.variable) ?? [];
      candidates.push(definition);
      byVariable.set(definition.variable, candidates);
    }
    for (const candidates of byVariable.values()) {
      const sameFile = candidates.filter((definition) => definition.path === file.path);
      const definition = sameFile.length === 1
        ? sameFile[0]
        : sameFile.length === 0 && candidates.length === 1
        ? candidates[0]
        : undefined;
      if (definition === undefined) continue;
      signals.push(...observationMismatches(file, definition));
    }
  }
  return deduplicate(signals);
}

function metricDefinitions(source: string): Array<Omit<MetricDefinition, "path">> {
  const definitions: Array<Omit<MetricDefinition, "path">> = [];
  const constructor = /\b([A-Za-z_]\w*)\s*(?::=|=)\s*(?:(?:prometheus|promauto)\.)New(?:Histogram|Summary)(?:Vec)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = constructor.exec(source)) !== null) {
    const variable = match[1];
    if (variable === undefined) continue;
    const openBrace = source.indexOf("{", constructor.lastIndex);
    if (openBrace === -1 || openBrace - constructor.lastIndex > 300) continue;
    const optionsType = source.slice(constructor.lastIndex, openBrace).trim();
    if (!/^(?:prometheus\.)?(?:HistogramOpts|SummaryOpts)$/.test(optionsType)) continue;
    const body = balancedBody(source, openBrace, "{", "}");
    if (body === null) continue;
    const metricName = metricNameFromOptions(body);
    const unit = declaredDurationUnit(metricName);
    if (metricName !== "" && unit !== null) definitions.push({ variable, metricName, unit });
  }
  return definitions;
}

function metricNameFromOptions(body: string): string {
  const nameField = body.match(/\bName\s*:\s*([^\n]+)/)?.[1] ?? "";
  const literals = [...nameField.matchAll(/"([^"]+)"/g)];
  return literals.at(-1)?.[1] ?? "";
}

function declaredDurationUnit(metricName: string): DurationUnit | null {
  const normalized = metricName.toLowerCase();
  for (const unit of ["milliseconds", "microseconds", "nanoseconds", "seconds"] as const) {
    if (normalized.endsWith(`_${unit}`)) return unit;
  }
  return null;
}

function observationMismatches(file: SourceRevision, definition: MetricDefinition): Signal[] {
  const variable = escapeRegExp(definition.variable);
  const observe = new RegExp(
    `\\b${variable}(?:\\s*\\.\\s*With(?:LabelValues|Labels)\\s*\\([\\s\\S]{0,500}?\\))?\\s*\\.\\s*Observe\\s*\\(`,
    "g",
  );
  const signals: Signal[] = [];
  let match: RegExpExecArray | null;
  while ((match = observe.exec(file.current)) !== null) {
    const openParen = (match.index ?? 0) + (match[0]?.lastIndexOf("(") ?? -1);
    if (openParen < (match.index ?? 0)) continue;
    const argument = balancedBody(file.current, openParen, "(", ")");
    if (argument === null) continue;
    const observedUnit = observedDurationUnit(argument);
    if (observedUnit === null || observedUnit === definition.unit) continue;
    const line = file.current.slice(0, match.index ?? 0).split("\n").length;
    signals.push({
      ruleId: "go-obs.metrics.duration-unit-mismatch",
      path: file.path,
      line,
      message: `Metric ${definition.metricName} declares ${definition.unit} but Observe records ${observedUnit}.`,
      snippet: (file.current.split("\n")[line - 1] ?? "").trim().slice(0, 300),
      data: {
        metric: definition.metricName,
        declaredUnit: definition.unit,
        observedUnit,
      },
    });
  }
  return signals;
}

function observedDurationUnit(argument: string): DurationUnit | null {
  if (/\.Milliseconds\s*\(\s*\)/.test(argument)) return "milliseconds";
  if (/\.Microseconds\s*\(\s*\)/.test(argument)) return "microseconds";
  if (/\.Nanoseconds\s*\(\s*\)/.test(argument)) return "nanoseconds";
  if (/\.Seconds\s*\(\s*\)/.test(argument)) return "seconds";
  if (/^\s*float64\s*\(\s*time\.Since\s*\(/.test(argument)) return "nanoseconds";
  return null;
}

function balancedBody(source: string, openIndex: number, open: string, close: string): string | null {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\" && quote !== "`") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character !== close) continue;
    depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  return null;
}

function metricDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deduplicate(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.path}:${signal.line}:${String(signal.data.metric)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
