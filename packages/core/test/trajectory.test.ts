import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrajectoryRunLoader, applySystemPrompts, applyToolDescriptions, trajectoryUrl } from "../src/trajectory.js";
import { RunStore } from "../src/persistence.js";
import { createLaunchSnapshot } from "../src/utils.js";
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
  assert.match(source, /function renderGantt\(record, timingsByAgent\)/);
  assert.doesNotMatch(source, /summary !== "—"/);
  assert.doesNotMatch(source, /agent-path/);
});

void test("trajectory transcript retention stays bounded with timing entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-cap-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  const transcript = Array.from({ length: 401 }, (_, index) => {
    const toolCallId = `call-${String(index)}`;
    return [
      { type: "message", message: { role: "toolResult", toolCallId } },
      { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId, toolName: "bash", startedAt: index, completedAt: index + 1, durationMs: 1, isError: false } },
    ];
  }).flat();
  writeFileSync(sessionFile, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "fixture-model" };
  const run = {
    id: "run", workflowName: "trajectory", cwd, sessionId: "session", state: "completed", agentSessions: [],
    agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", attempts: 1, model, tools: [], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: [] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
  } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trajectory" }, settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    const [loaded] = await createTrajectoryRunLoader(cwd, "session", home)();
    const entries = loaded?.transcripts.agent ?? [];
    assert.equal(entries.length, 800);
    assert.equal(entries.filter((entry) => (entry as { type?: string }).type === "custom").length, 400);
    assert.equal(entries.some((entry) => JSON.stringify(entry).includes("call-0")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
