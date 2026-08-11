import { type Signal, type SourceRevision } from "./types.js";

interface CounterDefinition {
  path: string;
  line: number;
  metricName: string;
  subject: string[] | null;
  denominatorTokens: string[];
}

const FAILURE_TOKENS = new Set(["error", "errors", "fail", "fails", "failed", "failure", "failures"]);
const DENOMINATOR_TOKENS = new Set(["attempt", "call", "execution", "operation"]);

/**
 * Find changed Prometheus metric families that expose failures without a
 * comparable event count. A failure counter is a numerator; without a
 * same-subject counter, its magnitude cannot be interpreted as a rate.
 */
export function failureCounterWithoutDenominatorSignals(files: SourceRevision[]): Signal[] {
  const byDirectory = new Map<string, CounterDefinition[]>();
  for (const file of files) {
    const directory = metricDirectory(file.path);
    const definitions = byDirectory.get(directory) ?? [];
    definitions.push(...counterDefinitions(file));
    byDirectory.set(directory, definitions);
  }

  const signals: Signal[] = [];
  for (const definitions of byDirectory.values()) {
    for (const failure of definitions) {
      if (failure.subject === null) continue;
      const hasDenominator = definitions.some(
        (candidate) => candidate !== failure && isDenominatorFor(candidate, failure.subject!),
      );
      if (hasDenominator) continue;
      signals.push({
        ruleId: "go-obs.metrics.failure-without-denominator",
        path: failure.path,
        line: failure.line,
        message: `Metric ${failure.metricName} counts failures without a comparable ${subjectName(failure.subject)} attempts or total counter.`,
        snippet: failure.metricName,
        data: {
          metric: failure.metricName,
          subject: failure.subject.join("_"),
        },
      });
    }
  }
  return signals.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function counterDefinitions(file: SourceRevision): CounterDefinition[] {
  const definitions: CounterDefinition[] = [];
  const constructor =
    /\b(?:(?:prometheus|promauto|metric)\.)NewCounter(?:VecWithLabels|Vec|Func)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = constructor.exec(file.current)) !== null) {
    const openBrace = file.current.indexOf("{", constructor.lastIndex);
    if (openBrace === -1 || openBrace - constructor.lastIndex > 300) continue;
    const optionsType = file.current.slice(constructor.lastIndex, openBrace).trim();
    if (!/^(?:prometheus\.|metric\.)?CounterOpts$/.test(optionsType)) continue;
    const body = balancedBody(file.current, openBrace, "{", "}");
    if (body === null) continue;
    const metricName = metricNameFromOptions(body);
    if (metricName === "") continue;
    const tokens = metricTokens(metricName);
    definitions.push({
      path: file.path,
      line: file.current.slice(0, match.index ?? 0).split("\n").length,
      metricName,
      subject: failureSubject(tokens),
      denominatorTokens: denominatorTokens(tokens),
    });
  }
  return definitions;
}

function metricNameFromOptions(body: string): string {
  const nameField = body.match(/\bName\s*:\s*([^\n]+)/)?.[1] ?? "";
  const literals = [...nameField.matchAll(/"([^"]+)"/g)];
  return literals.at(-1)?.[1] ?? "";
}

function metricTokens(metricName: string): string[] {
  const tokens = metricName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.at(-1) === "total") tokens.pop();
  return tokens;
}

function failureSubject(tokens: string[]): string[] | null {
  if (!tokens.some((token) => FAILURE_TOKENS.has(token))) return null;
  const subject = tokens
    .filter((token) => !FAILURE_TOKENS.has(token))
    .map(normalizeSubjectToken);
  return subject.length === 0 ? null : subject;
}

function denominatorTokens(tokens: string[]): string[] {
  return tokens.map(normalizeSubjectToken);
}

function isDenominatorFor(candidate: CounterDefinition, subject: string[]): boolean {
  if (candidate.subject !== null) return false;
  if (sameTokens(candidate.denominatorTokens, subject)) return true;

  const withoutQualifier = candidate.denominatorTokens.filter(
    (token) => !DENOMINATOR_TOKENS.has(token) || subject.includes(token),
  );
  return sameTokens(withoutQualifier, subject);
}

function normalizeSubjectToken(token: string): string {
  if (token.endsWith("ies") && token.length > 3) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function sameTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function subjectName(subject: string[]): string {
  return subject.join(" ");
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
