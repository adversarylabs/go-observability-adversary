import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadInScopeSources, type RuleContext } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "../src/analyze.ts";
import { discoverSources } from "../src/discover.ts";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-obs.metrics.failure-without-denominator";

test("an unrelated edit does not surface a legacy metric finding", async () => {
  const repo = await repositoryWithLegacyMetric();
  const path = "metrics.go";
  await writeFile(join(repo, path), legacyMetric("new unrelated diagnostic"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "modified");
  assert.deepEqual([...discovery.files[0]!.changedLines], [9]);
  assert.equal(discovery.files[0]?.previous, legacyMetric("old diagnostic"));

  const analysis = await analyzeDiscovery(discovery);
  assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), []);

  const review = await changedReview(repo, [path]);
  assert.deepEqual(review.findings.filter((finding) => finding.ruleId === ruleId), []);
});

test("an added Go file remains eligible in full", async () => {
  const repo = await repositoryWithLegacyMetric();
  const path = "added.go";
  await writeFile(join(repo, path), legacyMetric("added file"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "added");

  const analysis = await analyzeDiscovery(discovery);
  assert.equal(analysis.signals.filter((signal) => signal.ruleId === ruleId).length, 1);

  const review = await changedReview(repo, [path]);
  assert.equal(review.findings.filter((finding) => finding.ruleId === ruleId).length, 1);
});

async function repositoryWithLegacyMetric(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "go-observability-discover-"));
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await writeFile(join(repo, "metrics.go"), legacyMetric("old diagnostic"));
  await execute("git", ["add", "metrics.go"], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  return repo;
}

function legacyMetric(diagnostic: string): string {
  return `package fixture

import "github.com/prometheus/client_golang/prometheus"

var failures = prometheus.NewCounter(prometheus.CounterOpts{
	Name: "request_failures_total",
})
func logDiagnostic() {
	println(${JSON.stringify(diagnostic)})
}
`;
}

async function changedReview(repoPath: string, changedFiles: string[]) {
  return createApp().run({
    input: {
      source: { path: repoPath },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: changedFiles,
      },
    },
  });
}

function changedContext(repoPath: string, changedFiles: string[]): RuleContext {
  const change: RuleContext["change"] = {
    type: "diff",
    baseRef: "HEAD",
    headRef: "WORKTREE",
    scanMode: "changed",
    changedFiles,
    worktree: true,
  };
  return {
    repoPath,
    change,
    repoIndex: null,
    summary: {},
    cache: new Map(),
    relpath: (path) => path,
    glob: async () => [],
    rglob: async () => [],
    listInScopePaths: async () => [],
    loadInScopeSources: async (options) => loadInScopeSources(repoPath, change, options),
    model: {} as RuleContext["model"],
    observe: () => {},
    finding: () => {},
    review: {
      assessment: () => {},
      positive: () => {},
      observe: () => {},
      score: () => {},
      opinion: () => {},
    },
  };
}
