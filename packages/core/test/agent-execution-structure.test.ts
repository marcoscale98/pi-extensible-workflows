import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const agentExecutionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/agent-execution.ts");

void test("documents the local workflow session lifecycle transitions and state writers", () => {
  const source = readFileSync(agentExecutionPath, "utf8");
  const stateIndex = source.indexOf('  let state: "active" | "suspending" | "suspended" | "resuming" | "disposing" | "disposed"');
  assert.notEqual(stateIndex, -1, "local workflow session state declaration is missing");
  const nearbyComments = [...source.slice(Math.max(0, stateIndex - 600), stateIndex + 200).matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g)].map(([comment]) => comment);
  const lifecycleComment = nearbyComments.find((comment) => ["active", "suspending", "suspended", "resuming", "disposing", "disposed"].every((state) => comment.includes(state)) && /(?:->|→)/.test(comment));
  assert.ok(lifecycleComment, "the local session state machine needs one nearby transition diagram comment");
  assert.match(lifecycleComment, /suspend/i);
  assert.match(lifecycleComment, /resume/i);
  assert.match(lifecycleComment, /dispose/i);
  assert.match(lifecycleComment, /(?:write|assign|set|mutat).*state|state.*(?:write|assign|set|mutat)/i);
});
