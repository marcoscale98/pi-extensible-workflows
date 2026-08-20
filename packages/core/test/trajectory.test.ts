import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applySystemPrompts, applyToolDescriptions, trajectoryUrl } from "../src/trajectory.js";
import type { PersistedRun } from "../src/persistence.js";

void test("applySystemPrompts fills missing prompts from session records", () => {
  const run = { agents: [{ id: "a", attemptDetails: [{ session: { transport: "local", sessionId: "s1" } }] }, { id: "b", systemPrompt: "keep", attemptDetails: [{ session: { transport: "local", sessionId: "s2" } }] }] } as unknown as PersistedRun;
  const next = applySystemPrompts(run, [{ sessionId: "s1", attempt: 1, turn: 1, sha256: "x", prompt: "hello" }, { sessionId: "s2", attempt: 1, turn: 1, sha256: "y", prompt: "ignored" }]);
  assert.equal(next.agents[0]?.systemPrompt, "hello");
  assert.equal(next.agents[1]?.systemPrompt, "keep");
});

void test("applyToolDescriptions fills missing Pi tool descriptions", () => {
  const run = { agents: [{ tools: ["bash", "view_image"], toolDefinitions: [{ name: "keep", description: "kept" }] }, { tools: ["bash", "view_image"] }] } as unknown as PersistedRun;
  const next = applyToolDescriptions(run, new Map([["bash", "Execute a bash command"]]));
  assert.deepEqual(next.agents[0]?.toolDefinitions, [{ name: "keep", description: "kept" }]);
  assert.deepEqual(next.agents[1]?.toolDefinitions, [{ name: "bash", description: "Execute a bash command" }]);
});

void test("trajectoryUrl does not include an auth token", () => {
  assert.equal(trajectoryUrl(7432), "http://127.0.0.1:7432/");
});

void test("Trajectory agent grid groups persisted agent scopes", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  assert.match(source, /function agentGridGroups\(agents\)/);
  assert.match(source, /JSON\.stringify\(\[agent\.structuralPath \?\? \[\], agent\.parentBreadcrumb \?\? null\]\)/);
  assert.match(source, /agentGridGroups\(phaseAgents\)/);
  assert.match(source, /class="agent-grid-scope"/);
  assert.doesNotMatch(source, /const path = \[\.\.\.\(agent\.parentBreadcrumb/);
});

void test("Trajectory timelines keep cursors and agent-only range selection", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  assert.match(source, /bindTimeCursor\(\$\("swim"\), "\.axis \.ticks"\)/);
  assert.match(source, /bindTimeCursor\(\$\("agent-timeline"\), "\.axis \.ticks"\)/);
  assert.match(source, /bindBrush\(\$\("agent-timeline"\), "\.axis \.ticks", setAgentRange\)/);
  assert.doesNotMatch(source, /bindBrush\(\$\("swim"\)/);
  assert.doesNotMatch(source, /runRange/);
  assert.match(source, /id="reset-agent-range"/);
  assert.match(source, /\.swim \.lane \{ grid-template-columns: 16px 56px 1fr; \}/);
  assert.match(source, /\.swim \.axis \{ grid-template-columns: 80px 1fr; \}/);
  assert.match(source, /const middle = hasTime \? `\+\$\{fmtRuntime\(span \/ 2\)\}` : "—"/);
  assert.match(source, /if \(!hasTime\) state\.agentRange = null/);
  assert.match(source, /root\.dataset\.timelineHasTime !== "true"/);
  assert.doesNotMatch(source, /paintBrush\(root, selector, range\); callback\(range\)/);
  assert.doesNotMatch(source, /\.range-edge\.end\.stacked \{ top: -31px; \}/);
});
