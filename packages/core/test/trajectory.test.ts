import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
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
  assert.match(source, /class="agent-cell" title="\$\{esc\(toolSummary\)\}"/);
  assert.doesNotMatch(source, /const path = \[\.\.\.\(agent\.parentBreadcrumb/);
});

void test("Trajectory run view renders the complete persisted log stream", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  assert.match(source, /function renderLogs\(record\)/);
  assert.match(source, /filter\(\(event\) => event\.type === "log"\)/);
  assert.match(source, /fmtClock\(event\.timestamp\)/);
  assert.match(source, /class="logs-list"/);
  assert.match(source, /renderLogs\(record\)/);
  assert.match(source, /\.logs-list \{[^}]*overflow: auto/);
  assert.match(source, /\.log-message \{[^}]*white-space: pre-wrap/);
  assert.doesNotMatch(source, /slice\(-5\)/);
});

void test("Trajectory agent view requests a compacted transcript on demand", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  assert.match(source, /function requestTranscript\(/);
  assert.match(source, /type: "ui:transcript"/);
  assert.match(source, /message\.type === "transcript"/);
  assert.match(source, /requestTranscript\(found, agent\.id\)/);
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

type TrajectoryPreview = { text: string; names: string[]; overflow: number };
type TrajectoryPreviewHelpers = {
  compactSkillReadPreview: (entry: unknown, entries?: readonly unknown[]) => string | undefined;
  eventPreview: (entry: unknown, entries?: readonly unknown[]) => string;
  toolPreviewHtml: (entry: unknown, entries?: readonly unknown[]) => string;
  eventPreviewParts: (entry: unknown, entries?: readonly unknown[]) => TrajectoryPreview;
  eventSearchText: (entry: unknown, entries?: readonly unknown[]) => string;
  eventLabel: (kind: string) => string;
  entryDetails: (entry: unknown, agent: unknown, entries?: readonly unknown[]) => { kind: string; entry: unknown; agent: unknown };
};

function loadTrajectoryPreviewHelpers(source: string): TrajectoryPreviewHelpers {
  const helperStart = source.indexOf("    const esc");
  const helperEnd = source.indexOf("    function renderToolPane", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { compactSkillReadPreview, eventPreview, eventPreviewParts, toolPreviewHtml, eventSearchText, eventLabel, entryDetails }; })()`) as TrajectoryPreviewHelpers;
}

void test("Trajectory compacts canonical skill reads without losing event details", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryPreviewHelpers(source);
  const readCall = (id: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }] } });
  const toolResult = (id: string, toolName = "read") => ({ type: "message", _toolTiming: { durationMs: 12, isError: false }, message: { role: "toolResult", toolCallId: id, toolName, content: [] } });
  const skillArgs = { path: "/home/andrea/.pi/agent/skills/tigerstyle/SKILL.md", offset: 1, limit: 400 };
  const call = readCall("skill-read", skillArgs);
  const result = toolResult("skill-read");
  const entries = [call, result];
  assert.equal(helpers.compactSkillReadPreview(call, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.compactSkillReadPreview(result, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.eventPreview(call, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.eventPreview(result, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.entryDetails(call, {}, entries).kind, "skill");
  assert.equal(helpers.entryDetails(result, {}, entries).kind, "skill");
  assert.equal(helpers.eventLabel(helpers.entryDetails(call, {}, entries).kind), "SKILL");
  assert.equal(helpers.eventLabel(helpers.entryDetails(result, {}, entries).kind), "SKILL");
  assert.match(helpers.eventSearchText(call, entries), /read/);
  assert.match(helpers.eventSearchText(call, entries), /tigerstyle\/SKILL\.md/);

  const nestedArgs = { path: "/home/andrea/.pi/agent/skills/tigerstyle/scripts/check.ts", offset: 2, limit: 3 };
  const nestedCall = readCall("nested-read", nestedArgs);
  assert.equal(helpers.compactSkillReadPreview(nestedCall, [nestedCall]), undefined);
  assert.equal(helpers.eventPreview(nestedCall, [nestedCall]), "read");
  assert.equal(helpers.eventPreview(toolResult("nested-read"), [nestedCall, toolResult("nested-read")]), `read  path ${nestedArgs.path} · offset 2 · limit 3 · 12ms`);
  const nestedHtml = helpers.toolPreviewHtml(toolResult("nested-read"), [nestedCall, toolResult("nested-read")]);
  assert.match(nestedHtml, /class="tool-key">path<\/span>/);
  assert.match(nestedHtml, /class="tool-key">offset<\/span>/);
  assert.match(nestedHtml, /class="tool-key">limit<\/span>/);
  assert.match(nestedHtml, /class="tool-timing"> · 12ms<\/span>/);
  const nestedResult = toolResult("nested-read");
  assert.equal(helpers.entryDetails(nestedResult, {}, [nestedCall, nestedResult]).kind, "tool");
  const simpleBashCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "simple-bash-call", name: "bash", arguments: { command: "git status --short" } }] } };
  const simpleBashResult = toolResult("simple-bash-call", "bash");
  assert.equal(helpers.entryDetails(simpleBashResult, {}, [simpleBashCall, simpleBashResult]).kind, "tool");

  const longCommand = "npm run build --workspace=packages/core && TEST_FILES='dist/test/agent-execution.test.js' npm run test:run --workspace=packages/core";
  const bashCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: longCommand, timeout: 180 } }] } };
  const bashResult = { type: "message", message: { role: "toolResult", toolCallId: "bash-call", toolName: "bash", content: [] } };
  const bashHtml = helpers.toolPreviewHtml(bashResult, [bashCall, bashResult]);
  assert.match(bashHtml, /class="tool-key">command<\/span>/);
  assert.match(bashHtml, /class="tool-key">timeout<\/span>/);
  assert.match(bashHtml, new RegExp(`class="tool-value" title="${longCommand.replaceAll("&", "&amp;")}"[^>]*>${longCommand.slice(0, 80).replaceAll("&", "&amp;")}…<\\/span>`));
  assert.match(bashHtml, /class="tool-value" title="180">180<\/span>/);
  assert.match(helpers.eventSearchText(bashResult, [bashCall, bashResult]), /agent-execution\.test\.js/);
  assert.match(helpers.eventSearchText(bashResult, [bashCall, bashResult]), /timeout/);

  const emptyCall = readCall("empty", {});
  const emptyResult = { type: "message", message: { role: "toolResult", toolCallId: "empty", toolName: "bash", content: [] } };
  assert.equal(helpers.eventPreview(emptyResult, [emptyCall, emptyResult]), "bash");

  const scalarResult = { type: "message", message: { role: "toolResult", toolName: "bash", arguments: "echo hello", content: [] } };
  assert.doesNotThrow(() => helpers.toolPreviewHtml(scalarResult, [scalarResult]));
  assert.match(helpers.toolPreviewHtml(scalarResult, [scalarResult]), /bash.*echo hello/);
  const textCall = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Loading the skill now" }, { type: "toolCall", id: "text-read", name: "read", arguments: skillArgs }] } };
  assert.equal(helpers.compactSkillReadPreview(textCall, [textCall]), "[skill] tigerstyle:1-400");
  assert.equal(helpers.eventPreview(textCall, [textCall]), "[skill] tigerstyle:1-400");

  const multiCall = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "multi-skill", name: "read", arguments: skillArgs },
    { type: "toolCall", id: "multi-other", name: "read", arguments: nestedArgs },
    { type: "toolCall", id: "multi-bash", name: "bash", arguments: {} },
  ] } };
  assert.equal(helpers.compactSkillReadPreview(multiCall, [multiCall]), undefined);
  assert.equal(helpers.eventPreview(multiCall, [multiCall]), "read read bash");
  assert.equal(helpers.compactSkillReadPreview(toolResult("multi-skill"), [multiCall]), "[skill] tigerstyle:1-400");

  const filePathArgs = { file_path: "/tmp/other-skill/SKILL.md", offset: 2, limit: 1 };
  const filePathCall = readCall("file-path-read", filePathArgs);
  assert.equal(helpers.compactSkillReadPreview(filePathCall, [filePathCall]), "[skill] other-skill:2-2");
});

void test("Trajectory renders structured tool previews in event rows", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  assert.match(source, /const toolPreviewHtml =/);
  assert.match(source, /class="tool-key"/);
  assert.match(source, /class="tool-value"/);
  assert.match(source, /const compact = compactSkillReadPreview\(entry, entries\)/);
  assert.match(source, /toolPreviewHtml\(entry, entries\)/);
  assert.doesNotMatch(source, /<div class="preview">\$\{esc\(eventPreview\(entry, entries\)\)\}<\/div>/);
});

void test("Trajectory summarizes assistant tool calls without dropping searchable arguments", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryPreviewHelpers(source);
  const previewParts = (entry: unknown, entries: readonly unknown[] = []) => JSON.parse(JSON.stringify(helpers.eventPreviewParts(entry, entries))) as TrajectoryPreview;
  const call = (name: string, id: string, args: Record<string, unknown>) => ({ type: "toolCall", name, id, arguments: args });
  const assistant = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });

  const thinkingAndTools = assistant([
    { type: "thinking", thinking: "Inspecting repo status and files" },
    call("read", "read-1", { path: "a" }),
    call("bash", "bash-1", { command: "git status" }),
    call("grep", "grep-1", { pattern: "tigerstyle" }),
    call("read", "read-2", { path: "b" }),
    call("read", "read-3", { path: "c" }),
  ]);
  assert.deepEqual(previewParts(thinkingAndTools, [thinkingAndTools]), {
    text: "",
    names: ["read", "bash", "grep", "read", "read"],
    overflow: 2,
  });
  assert.match(helpers.eventSearchText(thinkingAndTools, [thinkingAndTools]), /git status/);
  assert.match(helpers.eventSearchText(thinkingAndTools, [thinkingAndTools]), /tigerstyle/);

  const textAndTools = assistant([{ type: "text", text: "I'll inspect" }, call("read", "read-1", { path: "a" }), call("bash", "bash-1", { command: "ls" })]);
  assert.deepEqual(previewParts(textAndTools, [textAndTools]), { text: "I'll inspect", names: ["read", "bash"], overflow: 0 });

  const textOnly = assistant([{ type: "text", text: "Done" }]);
  assert.deepEqual(previewParts(textOnly, [textOnly]), { text: "Done", names: [], overflow: 0 });

  const thinkingAndText = assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }]);
  assert.deepEqual(previewParts(thinkingAndText, [thinkingAndText]), { text: "Visible", names: [], overflow: 0 });
  const threeTools = assistant([call("read", "read-1", {}), call("bash", "bash-1", {}), call("grep", "grep-1", {})]);
  assert.deepEqual(previewParts(threeTools, [threeTools]), { text: "", names: ["read", "bash", "grep"], overflow: 0 });

  const contextToolCall = { type: "custom", message: { content: [call("bash", "context-bash", { command: "git status" })] } };
  assert.match(helpers.eventSearchText(contextToolCall, [contextToolCall]), /git status/);

  assert.match(source, /\.pill\.tool/);
  assert.match(source, /\.preview \.pill\.tool \{[^}]*margin-right: 4px/);
  assert.match(source, /\.preview \.preview-tool \{[^}]*font-size: 9px[^}]*padding: 1px 4px/);
  assert.match(source, /renderAssistantToolCalls/);
  assert.match(source, /toolCalls\.map\(\(call\)/);
  assert.match(source, /toolArgsOf\(call, entries\)/);
  assert.match(source, /esc\(preview\.text\)/);
  assert.match(source, /renderAssistantPreview\(eventPreviewParts\(entry, entries\)\)/);
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

type TrajectoryInspectorHelpers = {
  messageTokenRows: (kind: string, message: Record<string, unknown>, body: string) => string;
};

function loadTrajectoryInspectorHelpers(source: string): TrajectoryInspectorHelpers {
  const helperStart = source.indexOf("    const messageTokenRows");
  const helperEnd = source.indexOf("    const timingEntryType", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); const estTokens = (text) => Math.ceil(String(text || "").length / 4); ${source.slice(helperStart, helperEnd)}; return { messageTokenRows }; })()`) as TrajectoryInspectorHelpers;
}

void test("Trajectory message inspector distinguishes provider usage from estimates", () => {
  const source = readFileSync(new URL("../src/trajectory/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryInspectorHelpers(source);
  const renderStart = source.indexOf("    function renderInspector");
  const messageStart = source.indexOf("const message =", renderStart);
  const headerStart = source.indexOf('<div class="ins-head">', messageStart);
  const bodyStart = source.indexOf('<div class="ins-body">', headerStart);
  assert.ok(renderStart >= 0 && messageStart > renderStart && headerStart > messageStart && bodyStart > headerStart);
  assert.doesNotMatch(source.slice(headerStart, bodyStart), /tok|token/i);
  const providerRows = helpers.messageTokenRows("assistant", { usage: { input: 0, output: 8, reasoning: 3, cacheRead: 2, cacheWrite: 0 } }, "displayed text");
  assert.match(providerRows, /Input.*0 tok/);
  assert.match(providerRows, /Output.*8 tok/);
  assert.match(providerRows, /Reasoning.*3 tok/);
  assert.match(providerRows, /Cache read.*2 tok/);
  assert.doesNotMatch(providerRows, /est\./);
  assert.doesNotMatch(providerRows, /Total/);
  const noReasoningRows = helpers.messageTokenRows("assistant", { usage: { input: 1, output: 2 } }, "displayed text");
  assert.doesNotMatch(noReasoningRows, /Reasoning/);
  assert.equal(helpers.messageTokenRows("assistant", {}, "1234567"), '<div class="k">Tokens</div><div>est. 2 tok</div>');
  assert.equal(helpers.messageTokenRows("user", { usage: { input: 1, output: 2 } }, "1234567"), "");
});
