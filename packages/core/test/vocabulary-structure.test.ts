import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function source(name: string): string {
  return readFileSync(resolve(sourceRoot, name), "utf8");
}

function importsFrom(sourceText: string, symbol: string, module: string): boolean {
  return new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s+from\\s+["']${module}["']`, "s").test(sourceText);
}

void test("Pi runtime derives thinking validation from the canonical types vocabulary", () => {
  const types = source("types.ts");
  const adapter = source("pi-runtime-adapter.ts");
  const consumers = [adapter, source("decoders.ts")];

  assert.match(types, /export const THINKING_LEVELS = \[[^\]]+\] as const;/);
  assert.match(types, /export type ThinkingLevel = \(typeof THINKING_LEVELS\)\[number\];/);
  for (const consumer of consumers) {
    assert.equal(importsFrom(consumer, "THINKING_LEVELS", "\\./types\\.js"), true);
    assert.doesNotMatch(consumer, /["']off["']\s*,\s*["']minimal["']\s*,\s*["']low["']\s*,\s*["']medium["']\s*,\s*["']high["']\s*,\s*["']xhigh["']\s*,\s*["']max["']/);
  }
  assert.doesNotMatch(adapter, /^\s*const THINKING_LEVELS\s*=/m);
});

void test("scheduler and persistence state validation use the canonical agent-state vocabulary", () => {
  const types = source("types.ts");
  const execution = source("agent-execution.ts");
  const decoders = source("decoders.ts");

  assert.match(types, /export const AGENT_STATES = \[[^\]]+\] as const;/);
  assert.match(types, /export type AgentState = \(typeof AGENT_STATES\)\[number\];/);
  assert.equal(importsFrom(execution, "AgentState", "\\./types\\.js"), true);
  assert.match(execution, /state: AgentState;/);
  assert.doesNotMatch(execution, /state:\s*["']queued["']\s*\|/);

  assert.equal((decoders.match(/AGENT_STATES\.(?:some|includes)\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(decoders, /function isOwnershipState\s*\(/);
});

void test("host runtime and workflow evals reuse the shared workflow-error guard", () => {
  for (const name of ["host-runtime.ts", "workflow-evals.ts"]) {
    const sourceText = source(name);
    assert.equal(importsFrom(sourceText, "isWorkflowErrorCode", "\\./utils\\.js"), true, `${name} must import the shared guard directly from utils`);
    assert.doesNotMatch(sourceText, /function isWorkflowErrorCode\s*\(/, `${name} must not define a local guard`);
  }
});
