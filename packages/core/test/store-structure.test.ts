import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const storePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/store.ts");

function methodSource(source: string, name: string): string {
  const starts = [`  async ${name}(`, `  private async ${name}(`].map((signature) => source.indexOf(signature)).filter((start) => start >= 0);
  const start = starts.length === 0 ? -1 : Math.min(...starts);
  assert.notEqual(start, -1, `${name}() is missing`);
  const end = source.indexOf("\n  }", start);
  assert.notEqual(end, -1, `${name}() body is incomplete`);
  return source.slice(start, end);
}

void test("RunStore centralizes run identity checks in its five persistence paths", () => {
  const source = readFileSync(storePath, "utf8");
  assert.equal((source.match(/^\s{2}#assertRunIdentity\s*\(/gm) ?? []).length, 1);

  for (const [name, expectedCalls] of [["create", 1], ["load", 1], ["loadStatus", 1], ["saveState", 1], ["updateState", 2]] as const) {
    const calls = methodSource(source, name).match(/this\.#assertRunIdentity\s*\(/g) ?? [];
    assert.equal(calls.length, expectedCalls, `${name}() must use #assertRunIdentity for every identity check`);
  }
});

void test("RunStore centralizes worktree record loading with private missing-file semantics", () => {
  const source = readFileSync(storePath, "utf8");
  const declaration = /^\s{2}async #loadWorktreeRecords\(missingOk = true\)/gm;
  assert.equal((source.match(declaration) ?? []).length, 1, "#loadWorktreeRecords(missingOk = true) must be private and unique");

  const helperStart = source.indexOf("  async #loadWorktreeRecords(");
  const helperEnd = source.indexOf("\n  }", helperStart);
  assert.notEqual(helperStart, -1, "#loadWorktreeRecords() is missing");
  assert.notEqual(helperEnd, -1, "#loadWorktreeRecords() body is incomplete");
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /join\(this\.directory, "worktrees\.json"\)/);
  assert.match(helper, /isNodeError\(error, "ENOENT"\)/);
  assert.match(helper, /Worktree records are invalid/);

  const pathLoads = [...source.matchAll(/join\(this\.directory, "worktrees\.json"\)/g)];
  assert.equal(pathLoads.length, 1, "worktrees.json path must be owned by #loadWorktreeRecords()");
  assert.equal((source.match(/decodeWorktreeReferences\s*\(/g) ?? []).length, 1, "worktree records must be decoded only by #loadWorktreeRecords()");
  assert.equal((source.match(/Worktree records are invalid/g) ?? []).length, 1, "invalid worktree records must be rejected only by #loadWorktreeRecords()");

  for (const [name, expectedCalls, missingOk] of [
    ["ownedWorktree", 1, false],
    ["findNamedWorktree", 1, false],
    ["validateDeletionWorktrees", 1, false],
    ["validateNamedWorktrees", 1, false],
    ["ownsWorktree", 1, false],
    ["worktree", 2, true],
    ["worktrees", 1, true],
    ["validNamedWorktrees", 1, true],
    ["delete", 1, true],
  ] as const) {
    const calls = methodSource(source, name).match(new RegExp(`this\\.#loadWorktreeRecords\\(\\s*${missingOk ? "(?:true)?" : "false"}\\s*\\)`, "g")) ?? [];
    assert.equal(calls.length, expectedCalls, `${name}() must preserve its missingOk behavior through #loadWorktreeRecords()`);
  }
});
