import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { tmpdir } from "node:os";
import test from "node:test";
import extension, { breadcrumbLabel, createHerdrExtension, isFullyInspectableMode } from "../dist/index.js";
import { createLiveSessionHandoff, loadingRegistry, localAgentTransport, resetWorkflowRegistry } from "pi-extensible-workflows";

const piRuntime = { executable: process.execPath, entrypoint: "/originating/pi-coding-agent/dist/cli.js" };

void test("uses the global extension setting and complete breadcrumb labels", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-settings-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  assert.equal(isFullyInspectableMode(agentDir), true);
  assert.equal(breadcrumbLabel({ structuralPath: ["review", "nested"], parentBreadcrumb: "reviewLoop", callSite: "function:agent/foo", occurrence: 2 }, 3), "review > nested > reviewLoop > function:agent/foo #3");
});

void test("registers session and live actions when enabled", () => {
  const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-default-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" } });
  assert.deepEqual(Object.values(extension.agentAttemptActions ?? {}).map(({ label }) => label), ["Open session in Herdr pane", "Open live session in Herdr pane"]);
  const context = { session: { sessionId: "session", locator: { sessionFile: "/tmp/session.jsonl" } }, liveSession: {}, prepared: {}, handoff: {}, attempt: { setup: { cwd: process.cwd() } }, agent: { state: "completed" }, run: { cwd: process.cwd() }, signal: new AbortController().signal, ui: {} };
  assert.equal(extension.agentAttemptActions.openSession.visible({ ...context, liveSession: undefined }), true);
  assert.equal(extension.agentAttemptActions.openSession.visible({ ...context, liveSession: undefined, agent: { state: "running" } }), false);
  assert.equal(extension.agentAttemptActions.openSession.visible(context), false);
  assert.equal(extension.agentAttemptActions.openSession.visible({ ...context, session: undefined, liveSession: undefined }), false);
  assert.equal(extension.agentAttemptActions.openLiveSession.visible(context), true);
  assert.equal(extension.agentAttemptActions.openLiveSession.visible({ ...context, liveSession: undefined }), false);
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-full-action-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "agent", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(root, "agent", "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const fullyInspectable = createHerdrExtension({ agentDir: join(root, "agent"), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" } });
  assert.equal(fullyInspectable.agentAttemptActions.openLiveSession.visible(context), false);
  assert.equal(fullyInspectable.agentAttemptActions.openSession.visible({ ...context, liveSession: undefined }), true);
});
void test("skips Herdr transport replacement during inspection", () => {
  const herdr = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-inspection-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" } });
  const original = { id: "local" };
  const agent = { transport: original };
  herdr.agentSetupHooks.fullyInspectable.setup(agent, { identity: { structuralPath: ["review"], callSite: "doctor", occurrence: 1 }, run: { runId: "doctor", workflow: { name: "doctor" } }, signal: new AbortController().signal, mode: "inspection" });
  assert.equal(agent.transport, original);
});

void test("opens a completed session in a Herdr pane without taking ownership", async () => {
  const previousEnvironment = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR };
  Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
  Reflect.deleteProperty(process.env, "PI_CODING_AGENT_SESSION_DIR");
  try {
    const calls = [];
    const runner = async (args) => {
      calls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "pane", rect: { width: 80, height: 20 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "new-pane" } } });
      return "";
    };
    const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-completed-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
    await extension.agentAttemptActions.openSession.run({ session: { sessionId: "session", locator: { sessionFile: "/tmp/completed session.jsonl" } }, attempt: { setup: { cwd: process.cwd() } }, run: { cwd: process.cwd() }, signal: new AbortController().signal, ui: {} });
    assert.deepEqual(calls, [
      ["pane", "layout", "--pane", "pane"],
      ["pane", "split", "pane", "--direction", "right", "--no-focus"],
      ["pane", "run", "new-pane", `cd '${process.cwd()}' && pi --session '/tmp/completed session.jsonl' --tools 'read,grep,find,ls'`],
    ]);
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
});

void test("falls back to the run cwd when a completed attempt worktree was removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-removed-worktree-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  await rm(worktree, { recursive: true, force: true });
  try {
    const calls = [];
    const runner = async (args) => {
      calls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "pane", rect: { width: 80, height: 20 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "new-pane" } } });
      return "";
    };
    const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-fallback-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
    const context = { session: { sessionId: "session", locator: { sessionFile: "/tmp/completed session.jsonl" } }, attempt: { setup: { cwd: worktree } }, agent: { state: "completed" }, run: { cwd: root }, signal: new AbortController().signal, ui: {} };
    assert.equal(extension.agentAttemptActions.openSession.visible(context), true);
    await extension.agentAttemptActions.openSession.run(context);
    assert.deepEqual(calls, [
      ["pane", "layout", "--pane", "pane"],
      ["pane", "split", "pane", "--direction", "right", "--no-focus"],
      ["pane", "run", "new-pane", `cd '${root}' && pi --session '/tmp/completed session.jsonl' --tools 'read,grep,find,ls'`],
    ]);
    assert.equal(extension.agentAttemptActions.openSession.visible({ ...context, run: { cwd: join(root, "removed") } }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("opens the active session after the handoff boundary and releases on pane exit", async () => {
  const calls = [];
  let runCommand;
  let processReports = 0;
  const workingMessages = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "run") {
      const script = /sh '([^']+)'$/.exec(args[3]);
      runCommand = script ? readFileSync(script[1], "utf8") : args[3];
    }
    if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "pane", rect: { width: 80, height: 20 } }] } } });
    if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "new-pane" } } });
    if (args[1] === "process-info") {
      processReports += 1;
      return JSON.stringify({ result: { process_info: { foreground_processes: processReports === 2 ? [{ name: "node", argv: [process.execPath, piRuntime.entrypoint], cmdline: `${process.execPath} ${piRuntime.entrypoint}` }] : [] } } });
    }
    if (args[0] === "agent") return JSON.stringify({ result: { agent: { agent_status: "working" } } });
    return "";
  };
  const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-default-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const ownership = [];
  const longExtensionPaths = Array.from({ length: 34 }, (_, index) => `/agent/extensions/${"x".repeat(70)}-${String(index)}.mjs`);
  const longSkillPaths = Array.from({ length: 24 }, (_, index) => `/agent/skills/${"x".repeat(70)}-${String(index)}/SKILL.md`);
  const session = { reference: { transport: "local", sessionId: "session", locator: { sessionFile: "/tmp/session.jsonl" } }, suspendForHandoff: async () => ownership.push("suspend"), abort: async () => ownership.push("abort"), resumeFromHandoff: async () => ownership.push("resume"), getLastAssistant: () => ({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }), getHerdrResourcePaths: () => ({ extensions: ["/allowed-extension.mjs", ...longExtensionPaths], skills: ["/allowed-skill/SKILL.md", ...longSkillPaths] }) };
  const prepared = { cwd: "/repo", agentDir: "/agent", model: { provider: "openai", model: "gpt", thinking: "high" }, tools: ["read"], systemPrompt: "system", systemPromptAppend: "append", systemPromptPath: "/workflow/SYSTEM.md", extensionFactories: [function (pi) { pi.registerCommand("inline", { handler() {} }); }], additionalSkillPaths: ["/skill"], resourcePolicy: { projectTrusted: false, effective: { extensions: ["*"], skills: ["*"] } }, sessionLabel: "flow:review:attempt-1", piRuntime };
  const promise = extension.agentAttemptActions.openLiveSession.run({ liveSession: session, prepared, handoff, attempt: { attempt: 1 }, agent: { label: "reviewer", structuralPath: ["review"], parentBreadcrumb: "flow" }, run: {}, signal: new AbortController().signal, ui: { setWorkingMessage(message) { workingMessages.push(message); } } });
  await Promise.resolve();
  assert.equal(calls.length, 0);
  handoff.observe({ type: "turn_end" });
  await promise;
  const runCall = calls.find(([command, subcommand]) => command === "pane" && subcommand === "run");
  assert.deepEqual(workingMessages, ["reviewer: working", "reviewer: idle", undefined]);
  assert.equal(calls.filter(([command, subcommand]) => command === "pane" && subcommand === "run").length, 1);
  assert.ok(runCall);
  assert.ok(runCall[3].length < 4096);
  assert.ok(runCommand);
  assert.ok(runCommand.includes(`'${piRuntime.executable}' '${piRuntime.entrypoint}'`));
  assert.doesNotMatch(runCommand, /\bpi --session/);
  assert.ok(runCommand.includes("PI_CODING_AGENT_DIR='/agent'"));
  assert.ok(runCommand.includes("--model 'openai/gpt:high'"));
  assert.ok(runCommand.includes("--tools 'read'"));
  assert.ok(runCommand.includes(`--system-prompt '${join(tmpdir(), "pi-herdr-system-prompt-")}`));
  assert.ok(runCommand.includes(`--append-system-prompt '${join(tmpdir(), "pi-herdr-append-prompt-")}`));
  assert.ok(runCommand.includes("--skill '/skill'"));
  assert.ok(runCommand.includes("--extension '/allowed-extension.mjs'"));
  assert.ok(runCommand.includes("--skill '/allowed-skill/SKILL.md'"));
  assert.match(runCommand, /--no-extensions/);
  assert.match(runCommand, /--no-skills/);
  assert.match(runCommand, /--no-approve/);
  assert.ok(runCommand.includes("'Continue the current workflow task from this session.'"));
  assert.equal(runCommand.includes(`@'${join(tmpdir(), "pi-herdr-prompt-")}`), false);
  assert.match(runCommand, /--extension '.*pi-herdr-extensions-/);
  assert.ok(calls.some(([command, subcommand]) => command === "pane" && subcommand === "release-agent"));
  assert.equal(handoff.state, "completed");
  assert.ok(runCommand.length > 4096);
  assert.deepEqual(ownership, ["suspend", "resume"]);
});
void test("fails a Herdr handoff when the originating Pi runtime is unavailable", async () => {
  const calls = [];
  const runner = async (args) => { calls.push([...args]); return ""; };
  const herdr = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-runtime-missing-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const session = { reference: { transport: "local", sessionId: "session" }, getLastAssistant: () => ({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }), suspendForHandoff: async () => {}, resumeFromHandoff: async () => {} };
  const opening = herdr.agentAttemptActions.openLiveSession.run({ liveSession: session, prepared: { initialPrompt: "continue", piRuntimeError: "resolution failed" }, handoff, attempt: { attempt: 1 }, agent: {}, run: {}, signal: new AbortController().signal, ui: {} });
  handoff.observe({ type: "turn_end" });
  await assert.rejects(opening, /originating Pi runtime is unavailable \(resolution failed\)/);
  assert.equal(calls.some(([command, subcommand]) => command === "pane" && subcommand === "run"), false);
});
void test("opens a terminal live session without inventing a continuation", async () => {
  const calls = [];
  const ownership = [];
  let processReports = 0;
  let runCommand;
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "run") {
      const script = /sh '([^']+)'$/.exec(args[3]);
      runCommand = script ? readFileSync(script[1], "utf8") : args[3];
    }
    if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "pane", rect: { width: 80, height: 20 } }] } } });
    if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "new-pane" } } });
    if (args[1] === "process-info") {
      processReports += 1;
      return processReports === 1 ? JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } }) : JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
    }
    return "";
  };
  const extension = createHerdrExtension({ agentDir: mkdtempSync(join(tmpdir(), "herdr-extension-terminal-")), env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, runner });
  const handoff = createLiveSessionHandoff();
  handoff.observe({ type: "turn_started" });
  const session = { reference: { transport: "local", sessionId: "session" }, getLastAssistant: () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "completed report" }] }), suspendForHandoff: async () => ownership.push("suspend"), resumeFromHandoff: async () => ownership.push("resume") };
  const opening = extension.agentAttemptActions.openLiveSession.run({ liveSession: session, prepared: { cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: [], piRuntime }, handoff, attempt: { attempt: 1 }, agent: {}, run: {}, signal: new AbortController().signal, ui: {} });
  handoff.observe({ type: "turn_end" });
  await opening;
  const runCall = calls.find(([command, subcommand]) => command === "pane" && subcommand === "run");
  assert.ok(runCall);
  assert.ok(runCommand);
  assert.match(runCommand, /--session-id 'session'/);
  assert.doesNotMatch(runCommand, /Continue the current workflow task/);
  assert.deepEqual(ownership, ["suspend", "resume"]);
});
void test("reports terminal turns as idle", async () => {
  const handlers = new Map();
  const calls = [];
  let releaseAgent;
  let releaseStarted = false;
  const releaseFinished = new Promise((resolve) => { releaseAgent = resolve; });
  extension({
    on(name, handler) { const previous = handlers.get(name); handlers.set(name, previous ? async (...args) => { await previous(...args); await handler(...args); } : handler); },
    events: { on(name, handler) { handlers.set(name, handler); } },
  }, {
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane", PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER: "1" },
    runner: async (args) => { calls.push([...args]); if (args[1] === "release-agent") { releaseStarted = true; await releaseFinished; } return ""; },
  });
  const context = { hasUI: true, isIdle: () => false, sessionManager: { getSessionId: () => "session", getSessionFile: () => "/tmp/session.jsonl" } };
  await handlers.get("session_start")({ reason: "workflow-agent" }, context);
  await handlers.get("turn_end")({ message: { content: [{ type: "text", text: "done" }] } }, context);
  await handlers.get("agent_start")({}, context);
  await handlers.get("turn_end")({ message: { content: [{ type: "toolCall", name: "workflow_result" }] } }, context);
  await handlers.get("agent_start")({}, context);
  await handlers.get("agent_settled")({}, context);
  assert.deepEqual(calls.filter(([command, subcommand]) => command === "pane" && subcommand === "report-agent").map((args) => args[args.indexOf("--state") + 1]), ["working", "idle", "working", "idle", "working", "idle"]);
  const shutdown = handlers.get("session_shutdown")({ reason: "quit" }, context);
  assert.ok(shutdown instanceof Promise);
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(releaseStarted, true);
  let shutdownFinished = false;
  shutdown.then(() => { shutdownFinished = true; });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  releaseAgent();
  await shutdown;
});

void test("resumes and terminally disposes the local session when initial Herdr pane launch fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-initial-launch-failure-"));
  try {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const lifecycle = [];
  let sessionNumber = 0;
  const recorder = (pi) => {
    const id = ++sessionNumber;
    pi.on("session_start", (event) => { lifecycle.push(`start:${id}:${event.reason}`); if (id === 2 && event.reason === "resume") throw new Error("resume binding failed"); });
    pi.on("session_shutdown", (event) => lifecycle.push(`shutdown:${id}:${event.reason}`));
  };
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab-root" }, root_pane: { pane_id: "pane-root" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-child" }, root_pane: { pane_id: "pane-child" } } });
    if (args[0] === "pane" && args[1] === "run") throw new Error("pane launch failed");
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const agent = { transport: localAgentTransport };
  const context = { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run: { runId: "run", workflow: { name: "flow" } }, signal: new AbortController().signal };
  extension.agentSetupHooks.fullyInspectable.setup(agent, context);
  const prepared = { cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], extensionFactories: [recorder], initialPrompt: "initial", sessionLabel: "flow:review", piRuntime };
  await assert.rejects(agent.transport.createSession(prepared, { ...context, attempt: 1 }), (error) => error instanceof Error && error.message === "pane launch failed");
  assert.deepEqual(lifecycle, ["start:1:startup", "shutdown:1:resume", "start:2:resume", "shutdown:2:quit"]);
  assert.equal(calls.filter(([command, subcommand]) => command === "pane" && subcommand === "run").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test("restores the previous local generation after an initial pane launch failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-initial-launch-restoration-"));
  try {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const lifecycle = [];
  let sessionNumber = 0;
  const recorder = (pi) => {
    const id = ++sessionNumber;
    pi.on("session_start", (event) => lifecycle.push({ type: "session_start", id, reason: event.reason, ...(event.previousSessionFile ? { previousSessionFile: event.previousSessionFile } : {}) }));
    pi.on("session_shutdown", (event) => lifecycle.push({ type: "session_shutdown", id, reason: event.reason }));
  };
  const runner = async (args) => {
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab-root" }, root_pane: { pane_id: "pane-root" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-child" }, root_pane: { pane_id: "pane-child" } } });
    if (args[0] === "pane" && args[1] === "run") throw new Error("pane launch failed");
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const agent = { transport: localAgentTransport };
  const context = { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run: { runId: "run", workflow: { name: "flow" } }, signal: new AbortController().signal };
  extension.agentSetupHooks.fullyInspectable.setup(agent, context);
  const prepared = { cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], extensionFactories: [recorder], initialPrompt: "initial", sessionLabel: "flow:review", piRuntime };
  await assert.rejects(agent.transport.createSession(prepared, { ...context, attempt: 1 }), (error) => error instanceof Error && error.message === "pane launch failed");
  assert.deepEqual(lifecycle.slice(0, 2), [
    { type: "session_start", id: 1, reason: "startup" },
    { type: "session_shutdown", id: 1, reason: "resume" },
  ]);
  assert.equal(lifecycle.length, 4);
  assert.deepEqual(lifecycle[3], { type: "session_shutdown", id: 2, reason: "quit" });
  assert.equal(lifecycle[2]?.type, "session_start");
  assert.equal(lifecycle[2]?.id, 2);
  assert.equal(lifecycle[2]?.reason, "resume");
  assert.equal(typeof lifecycle[2]?.previousSessionFile, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test("preserves an initial pane launch error when local disposal also fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-disposal-error-precedence-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const runner = async (args) => {
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab-root" }, root_pane: { pane_id: "pane-root" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-child" }, root_pane: { pane_id: "pane-child" } } });
    if (args[0] === "pane" && args[1] === "run") throw new Error("pane launch failed");
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  let disposalAttempts = 0;
  const agent = { transport: { id: "local", async createSession(value) { return { reference: { transport: "local", sessionId: "session", locator: { sessionFile: "/tmp/session.jsonl" } }, suspendForHandoff: async () => {}, resumeFromHandoff: async () => {}, getLastAssistant: () => ({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }), getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), dispose: async () => { disposalAttempts += 1; throw new Error("dispose failed"); } }; } } };
  const context = { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run: { runId: "run", workflow: { name: "flow" } }, signal: new AbortController().signal };
  extension.agentSetupHooks.fullyInspectable.setup(agent, context);
  try {
    await assert.rejects(agent.transport.createSession({ cwd: root, model: { provider: "fake", model: "model" }, tools: [], initialPrompt: "initial", sessionLabel: "flow:review", piRuntime }, { ...context, attempt: 1 }), (error) => error instanceof Error && error.message === "pane launch failed");
    assert.equal(disposalAttempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test("disposes a Herdr wrapper while a subsequent pane is still launching", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-launch-disposal-race-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const calls = [];
  let paneRuns = 0;
  let firstProcessReports = 0;
  let secondProcessReports = 0;
  let secondClosed = false;
  let launchReleased = false;
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "root-tab" }, root_pane: { pane_id: "root-pane" } } });
    if (args[0] === "tab" && args[1] === "create") { const number = calls.filter(([command, subcommand]) => command === "tab" && subcommand === "create").length; return JSON.stringify({ result: { tab: { tab_id: `tab-${number}` }, root_pane: { pane_id: `pane-${number}` } } }); }
    if (args[0] === "pane" && args[1] === "run") { paneRuns += 1; if (paneRuns === 2) { await launchGate; launchReleased = true; } return ""; }
    if (args[0] === "tab" && args[1] === "close") { if (args[2] === "tab-2") secondClosed = true; return ""; }
    if (args[0] === "pane" && args[1] === "process-info") {
      if (args[3] === "pane-1") return firstProcessReports++ === 0 ? JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } }) : JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
      if (!launchReleased || secondProcessReports++ > 0) return JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
      return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } });
    }
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const agent = { transport: { id: "local", async createSession(value) { return { reference: { transport: "local", sessionId: "session", locator: { sessionFile: "/tmp/session.jsonl" } }, suspendForHandoff: async () => {}, resumeFromHandoff: async () => {}, getLastAssistant: () => ({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }), getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => ({ assistant: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }), abort: async () => {}, dispose: async () => {} }; } } };
  const context = { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run: { runId: "run", workflow: { name: "flow" } }, signal: new AbortController().signal };
  extension.agentSetupHooks.fullyInspectable.setup(agent, context);
  const prepared = { cwd: root, model: { provider: "fake", model: "model" }, tools: [], initialPrompt: "initial", sessionLabel: "flow:review", piRuntime };
  const session = await agent.transport.createSession(prepared, { ...context, attempt: 1 });
  let pending;
  let secondDisposal;
  try {
    await session.prompt("first");
    pending = session.prompt("second");
    while (paneRuns < 2) await new Promise((resolve) => globalThis.setImmediate(resolve));
    const disposal = session.dispose();
    secondDisposal = session.dispose();
    let secondSettled = false;
    void secondDisposal.then(() => { secondSettled = true; });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(secondSettled, false);
    releaseLaunch();
    await Promise.all([pending, disposal, secondDisposal]);
    assert.equal(secondClosed, true);
  } finally {
    releaseLaunch();
    launchReleased = true;
    await Promise.all([pending ?? Promise.resolve(), secondDisposal ?? Promise.resolve(), session.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});
void test("routes fully inspectable agents into one labeled workflow workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-full-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const calls = [];
  let runCommand;
  let agentReports = 0;
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "run") {
      const script = /sh '([^']+)'$/.exec(args[3]);
      runCommand = script ? readFileSync(script[1], "utf8") : args[3];
    }
    if (args[0] === "workspace") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } } });
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } });
    if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { agent_status: agentReports++ % 2 === 0 ? "working" : "idle" } } });
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const prepared = { cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: ["read"], systemPromptPath: "/repo/.pi/pi-extensible-workflows/SYSTEM.md", contextFiles: ["project"], initialPrompt: "x".repeat(5000), sessionLabel: "flow:review:attempt-1", piRuntime };
  let received;
  const agent = { transport: { id: "local", async createSession(value) { received = value; return { reference: { transport: "local", sessionId: "session" }, getHerdrContextFiles: () => [{ path: "/repo/AGENTS.md", content: "project instructions" }], getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), subscribe: () => () => {}, prompt: async () => ({}), steer: async () => {}, abort: async () => {}, dispose: async () => {} }; } } };
  const identity = { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "function:agent/work", occurrence: 1 };
  extension.agentSetupHooks.fullyInspectable.setup(agent, { identity, run: { runId: "run", workflow: { name: "flow" } }, signal: new AbortController().signal, tuiIndex: 1, tuiLabel: "reviewer" });
  const session = await agent.transport.createSession(prepared, { identity, attempt: 1 });
  assert.equal(received, prepared);
  assert.equal(session.reference.transport, "herdr");
  await session.prompt("continue");
  const secondSession = await agent.transport.createSession(prepared, { identity, attempt: 2 });
  assert.deepEqual(calls[0], ["workspace", "create", "--cwd", "/repo", "--label", "workflow flow", "--no-focus"]);
  assert.deepEqual(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "create"), [
    ["tab", "create", "--workspace", "workspace", "--cwd", "/repo", "--label", "#1 reviewer", "--no-focus"],
    ["tab", "create", "--workspace", "workspace", "--cwd", "/repo", "--label", "#1 reviewer", "--no-focus"],
  ]);
  await secondSession.prompt("continue");
  await session.dispose();
  await secondSession.dispose();
  assert.equal(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "close").length, 2);
  const runCall = calls.find(([command, subcommand]) => command === "pane" && subcommand === "run");
  assert.ok(runCall);
  assert.ok(runCommand.includes("--system-prompt '/repo/.pi/pi-extensible-workflows/SYSTEM.md'"));
  assert.match(runCommand, /--no-context-files/);
  assert.match(runCommand, /--append-system-prompt '.*pi-herdr-context-prompt-/);
  assert.ok(runCommand.includes(`@'${join(tmpdir(), "pi-herdr-prompt-")}`));
  assert.ok(runCommand.length < 4096);
});
void test("hands off sequential fully inspectable prompts and cleans the active tab on abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-sequential-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const calls = [];
  const statusReports = new Map();
  let tabNumber = 0;
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "root-tab" }, root_pane: { pane_id: "root-pane" } } });
    if (args[0] === "tab" && args[1] === "create") { const number = ++tabNumber; return JSON.stringify({ result: { tab: { tab_id: `tab-${number}` }, root_pane: { pane_id: `pane-${number}` } } }); }
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } });
    if (args[0] === "agent" && args[1] === "get") { const pane = args[2]; const reports = (statusReports.get(pane) ?? 0) + 1; statusReports.set(pane, reports); return JSON.stringify({ result: { agent: { agent_status: pane === "pane-3" ? "working" : reports === 1 ? "working" : "idle" } } }); }
    return "";
  };
  const extension = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const ownership = [];
  const controller = new AbortController();
  const agent = { transport: { id: "local", async createSession(value) { return { reference: { transport: "local", sessionId: "session" }, suspendForHandoff: async () => ownership.push("suspend"), resumeFromHandoff: async () => ownership.push("resume"), abort: async () => ownership.push("abort"), getLastAssistant: () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }), dispose: async () => {}, getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }) }; } } };
  const run = { runId: "run", workflow: { name: "flow" } };
  const context = { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run, signal: controller.signal, tuiIndex: 1, tuiLabel: "reviewer" };
  extension.agentSetupHooks.fullyInspectable.setup(agent, context);
  const prepared = { cwd: "/repo", model: { provider: "fake", model: "model" }, tools: [], initialPrompt: "initial", sessionLabel: "flow:review", piRuntime };
  const session = await agent.transport.createSession(prepared, { attempt: 1, signal: controller.signal });
  await session.prompt("first");
  assert.deepEqual(ownership, ["suspend", "resume"]);
  await session.prompt("second");
  assert.deepEqual(ownership, ["suspend", "resume", "suspend", "resume"]);
  const activePrompt = session.prompt("third");
  while (!calls.some(([command, subcommand, pane]) => command === "pane" && subcommand === "run" && pane === "pane-3")) await new Promise((resolve) => globalThis.setImmediate(resolve));
  controller.abort();
  await activePrompt;
  assert.equal(calls.filter(([command, subcommand, tab]) => command === "tab" && subcommand === "close" && tab === "tab-3").length, 1);
  await session.dispose();
  assert.deepEqual(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "close").map((args) => args[2]), ["tab-1", "tab-2", "tab-3"]);
  await rm(root, { recursive: true, force: true });
});
void test("bridges unknown tools and aborts forwarded tool calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-bridge-"));
  const agentDir = join(root, "agent"); mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  let runCommand; const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "workspace") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } } });
    if (args[0] === "pane" && args[1] === "run") { const script = /sh '([^']+)'$/.exec(args[3]); runCommand = script ? readFileSync(script[1], "utf8") : args[3]; }
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } });
    return "";
  };
  const entered = []; const tool = { name: "slow", label: "Slow", description: "Wait", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(_id, _params, signal) { entered.push(true); await new Promise((resolve, reject) => { const abort = () => reject(new Error("tool observed abort")); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }); return { content: [{ type: "text", text: "done" }] }; } };
  const herdr = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner });
  const agent = { transport: { id: "local", async createSession(value) { return { reference: { transport: "local", sessionId: "session" }, getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => ({}), abort: async () => {}, dispose: async () => {} }; } } };
  const controller = new AbortController();
  herdr.agentSetupHooks.fullyInspectable.setup(agent, { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run: { runId: "run", workflow: { name: "flow" } }, signal: controller.signal });
  const prepared = { cwd: "/repo", model: { provider: "fake", model: "model" }, tools: [], customTools: [tool], initialPrompt: "work", sessionLabel: "flow:review", piRuntime };
  const session = await agent.transport.createSession(prepared, { attempt: 1, signal: controller.signal });
  try {
    assert.ok(runCommand); const extensionPath = /--extension '([^']*pi-herdr-tools-[^']+\.mjs)'/.exec(runCommand)?.[1]; assert.ok(extensionPath);
    const bridgeSource = readFileSync(extensionPath, "utf8"); const socketPath = JSON.parse(/const socketPath = (.+);/.exec(bridgeSource)?.[1] ?? "null");
    const unknown = await new Promise((resolve, reject) => { const socket = net.createConnection(socketPath); let data = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { data += chunk; const line = data.split("\n")[0]; if (line) { resolve(JSON.parse(line)); socket.destroy(); } }); socket.on("error", reject); socket.on("connect", () => socket.write(JSON.stringify({ toolCallId: "unknown", name: "missing", params: {} }) + "\n")); });
    assert.deepEqual(unknown, { type: "error", error: "Unknown Herdr tool: missing" });
    const malformed = await new Promise((resolve, reject) => { const socket = net.createConnection(socketPath); let data = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { data += chunk; const line = data.split("\n")[0]; if (line) { resolve(JSON.parse(line)); globalThis.setImmediate(() => socket.destroy()); } }); socket.on("error", reject); socket.on("connect", () => socket.write(`${JSON.stringify({})}\n${JSON.stringify({ toolCallId: "ignored", name: "slow", params: {} })}\n`)); });
    assert.deepEqual(malformed, { type: "error", error: "Unknown Herdr tool: undefined" });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(entered.length, 0);
    let bridged; const bridgeModule = await import(pathToFileURL(extensionPath).href); bridgeModule.default({ registerTool(candidate) { bridged = candidate; } }); assert.ok(bridged);
    const pending = bridged.execute("abort-call", {}, controller.signal, () => {});
    while (!entered.length) await new Promise((resolve) => globalThis.setImmediate(resolve));
    controller.abort(); await assert.rejects(pending, /Herdr tool call aborted/);
  } finally { controller.abort(); await session.dispose(); await new Promise((resolve) => globalThis.setTimeout(resolve, 0)); await rm(root, { recursive: true, force: true }); }
});
void test("closes workspaces for every terminal run state and session shutdown", async () => {
  const handlers = new Map(); const closed = []; let closeAll = 0;
  let releaseCloseAll;
  const closeAllFinished = new Promise((resolve) => { releaseCloseAll = resolve; });
  const workspaces = { close: async (runId) => { closed.push(runId); }, closeAll: async () => { closeAll += 1; await closeAllFinished; } };
  const pi = { events: { on(name, handler) { handlers.set(name, handler); } }, on(name, handler) { handlers.set(name, handler); } };
  resetWorkflowRegistry();
  extension(pi, { env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane" }, workspaces });
  for (const state of ["failed", "stopped", "interrupted", "budget_exhausted"]) await handlers.get("workflow:run-state-changed")({ runId: state, state });
  await handlers.get("workflow:run-completed")({ runId: "completed" });
  const shutdown = handlers.get("session_shutdown")();
  let shutdownFinished = false;
  shutdown.then(() => { shutdownFinished = true; });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  releaseCloseAll();
  await shutdown;
  assert.deepEqual(closed, ["failed", "stopped", "interrupted", "budget_exhausted", "completed"]); assert.equal(closeAll, 1);
});
void test("default workspace manager reuses one workspace and closes it once on completion", async () => {
  resetWorkflowRegistry();
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-workspace-lifecycle-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  const handlers = new Map();
  const calls = [];
  let tabNumber = 0;
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "workspace" && args[1] === "create") return JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, tab: { tab_id: "root-tab" }, root_pane: { pane_id: "root-pane" } } });
    if (args[0] === "tab" && args[1] === "create") { const number = ++tabNumber; return JSON.stringify({ result: { tab: { tab_id: `tab-${number}` }, root_pane: { pane_id: `pane-${number}` } } }); }
    return "";
  };
  const pi = { events: { on(name, handler) { handlers.set(name, handler); } }, on(name, handler) { handlers.set(name, handler); } };
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { extension(pi, { env, runner }); } finally { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; }
  const hook = loadingRegistry().agentSetupHooks().find(({ name }) => name === "fullyInspectable");
  assert.ok(hook);
  const run = { runId: "run", workflow: { name: "flow" } };
  const agent = { transport: { id: "local", async createSession(value) { return { reference: { transport: "local", sessionId: `session-${value.initialPrompt}` }, suspendForHandoff: async () => {}, getLastAssistant: () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }), dispose: async () => {}, getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }) }; } } };
  hook.setup(agent, { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run, signal: new AbortController().signal });
  const prepared = { cwd: "/repo", model: { provider: "fake", model: "model" }, tools: [], initialPrompt: "work", sessionLabel: "flow:review", piRuntime };
  const first = await agent.transport.createSession(prepared, { attempt: 1 });
  const second = await agent.transport.createSession(prepared, { attempt: 2 });
  await first.dispose();
  await second.dispose();
  await handlers.get("workflow:run-completed")({ runId: run.runId });
  await handlers.get("session_shutdown")();
  assert.equal(calls.filter(([command, subcommand]) => command === "workspace" && subcommand === "create").length, 1);
  assert.equal(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "create").length, 2);
  assert.equal(calls.filter(([command, subcommand]) => command === "workspace" && subcommand === "close").length, 1);
  assert.equal(calls.filter(([command, subcommand]) => command === "tab" && subcommand === "close").length, 2);
  await rm(root, { recursive: true, force: true });
});
void test("relays generated tool bridge results, errors, and updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-extension-tool-bridge-"));
  const agentDir = join(root, "agent"); mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ extensions: { herdr: { enableFullyInspectableMode: true } } }));
  let runCommand;
  const runner = async (args) => {
    if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "node", argv: [process.execPath, piRuntime.entrypoint] }] } } });
    if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { agent_status: "working" } } });
    return "";
  };
  const workspaces = { open: async (_run, request) => { const commandFile = /sh '([^']+)'$/.exec(request.command)?.[1]; runCommand = commandFile ? readFileSync(commandFile, "utf8") : request.command; return { workspaceId: "workspace", tabId: "tab", paneId: "pane" }; } };
  const calls = [];
  const tool = { name: "bridge", label: "Bridge", description: "Bridge", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(toolCallId, params, _signal, onUpdate) {
    calls.push({ toolCallId, params });
    if (params.mode === "error") throw new Error("tool failed");
    onUpdate({ state: "working" });
    return { content: [{ type: "text", text: "tool result" }] };
  } };
  const herdr = createHerdrExtension({ agentDir, env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "parent" }, runner, workspaces });
  const agent = { transport: { id: "local", async createSession(value) { return { reference: { transport: "local", sessionId: "session" }, getState: () => ({ model: value.model, tools: value.tools }), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), abort: async () => {}, dispose: async () => {} }; } } };
  const controller = new AbortController();
  herdr.agentSetupHooks.fullyInspectable.setup(agent, { identity: { structuralPath: ["review"], parentBreadcrumb: "flow", callSite: "agent", occurrence: 1 }, run: { runId: "run", workflow: { name: "flow" } }, signal: controller.signal });
  const prepared = { cwd: "/repo", model: { provider: "fake", model: "model" }, tools: [], customTools: [tool], initialPrompt: "work", sessionLabel: "flow:review", piRuntime };
  const session = await agent.transport.createSession(prepared, { attempt: 1, signal: controller.signal });
  try {
    assert.ok(runCommand);
    const extensionPath = /--extension '([^']*pi-herdr-tools-[^']+\.mjs)'/.exec(runCommand)?.[1];
    assert.ok(extensionPath);
    const bridgeModule = await import(pathToFileURL(extensionPath).href);
    const registered = [];
    bridgeModule.default({ registerTool(candidate) { registered.push(candidate); } });
    assert.equal(registered.length, 1);
    const updates = [];
    const result = await registered[0].execute("success-call", { mode: "success" }, controller.signal, (update) => updates.push(update));
    assert.deepEqual(result, { content: [{ type: "text", text: "tool result" }] });
    assert.deepEqual(updates, [{ state: "working" }]);
    assert.deepEqual(calls, [{ toolCallId: "success-call", params: { mode: "success" } }]);
    await assert.rejects(registered[0].execute("error-call", { mode: "error" }, controller.signal, () => {}), /tool failed/);
    assert.deepEqual(calls.at(-1), { toolCallId: "error-call", params: { mode: "error" } });
  } finally { controller.abort(); await session.dispose(); await rm(root, { recursive: true, force: true }); }
});
