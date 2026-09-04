import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAdversaryManifest } from "@adversarylabs/sdk";

test("manifest, npm, source, bundle, and artifact assertion share one version", async () => {
  const [manifestText, packageText, lockText, source, bundle, artifactTest] = await Promise.all([
    readFile(new URL("../adversary.yaml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.js", import.meta.url), "utf8"),
    readFile(new URL("./runtime-artifact.test.ts", import.meta.url), "utf8"),
  ]);
  const version = parseAdversaryManifest(manifestText).version;
  const packageJson = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  assert.equal(version, "0.0.14");
  assert.equal(packageJson.version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  for (const text of [source, bundle, artifactTest]) {
    assert.match(text, new RegExp(`version[:), .\\\"]+\\\"?${version.replaceAll(".", "\\.")}\\\"?`));
  }
});
