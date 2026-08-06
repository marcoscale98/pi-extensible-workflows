/* global URL, setTimeout */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { WorkflowError, loadingRegistry, registerWorkflowExtension, resetWorkflowRegistry } from "pi-extensible-workflows";
import extension, {
  createSubagentManager,
  createSubagentTools,
  registerSubagentsExtension,
  SUBAGENTS_LIST_PARAMETERS,
  SUBAGENTS_RESULT_PARAMETERS,
  SUBAGENTS_RETRY_PARAMETERS,
  SUBAGENTS_RUN_PARAMETERS,
  SUBAGENTS_STATUS_PARAMETERS,
  SUBAGENTS_STEER_PARAMETERS,
  SUBAGENTS_STOP_PARAMETERS,
} from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const toolNames = [
  "subagents_run",
  "subagents_status",
  "subagents_result",
  "subagents_steer",
  "subagents_stop",
  "subagents_retry",
  "subagents_list",
];

function testContext() {
  return {};
}

test("registers namespaced subagent tools and delegates to an injected manager", async () => {
  const calls = [];
  const manager = {
    async run(params) { calls.push(["run", params]); return { id: "agent-1", state: "queued" }; },
    async status(params) { calls.push(["status", params]); return { id: params.id, state: "running" }; },
    async result(params) { calls.push(["result", params]); return { id: params.id, value: "done" }; },
    async steer(params) { calls.push(["steer", params]); return { id: params.id, accepted: true }; },
    async stop(params) { calls.push(["stop", params]); return { id: params.id, state: "stopped" }; },
    async retry(params) { calls.push(["retry", params]); return { id: params.id, state: "queued" }; },
    async list(params) { calls.push(["list", params]); return [{ id: "agent-1" }]; },
  };
  const tools = [];
  extension({ registerTool(tool) { tools.push(tool); } }, { manager });
  assert.equal(Object.isFrozen(SUBAGENTS_RUN_PARAMETERS), false);
  assert.deepEqual(tools.map(({ name }) => name), toolNames);
  const result = await tools[0].execute("call-1", { prompt: "inspect" }, undefined, undefined, testContext());
  assert.deepEqual(result, { content: [{ type: "text", text: '{"id":"agent-1","state":"queued"}' }], details: { id: "agent-1", state: "queued" } });
  assert.deepEqual(calls[0], ["run", { prompt: "inspect" }]);
});

test("exposes closed tool schemas for each control operation", () => {
  assert.deepEqual(Object.keys(SUBAGENTS_RUN_PARAMETERS.properties), ["prompt", "label", "model", "thinking", "tools", "role", "worktree", "outputSchema", "retries", "timeoutMs"]);
  assert.deepEqual(SUBAGENTS_RUN_PARAMETERS.required, ["prompt"]);
  assert.equal(SUBAGENTS_RUN_PARAMETERS.additionalProperties, false);

  for (const schema of [SUBAGENTS_STATUS_PARAMETERS, SUBAGENTS_RESULT_PARAMETERS, SUBAGENTS_STOP_PARAMETERS, SUBAGENTS_RETRY_PARAMETERS]) {
    assert.deepEqual(Object.keys(schema.properties), ["id"]);
    assert.deepEqual(schema.required, ["id"]);
    assert.equal(schema.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(SUBAGENTS_STEER_PARAMETERS.properties), ["id", "message"]);
  assert.deepEqual(SUBAGENTS_STEER_PARAMETERS.required, ["id", "message"]);
  assert.equal(SUBAGENTS_STEER_PARAMETERS.additionalProperties, false);
  assert.deepEqual(Object.keys(SUBAGENTS_LIST_PARAMETERS.properties), []);
  assert.equal(SUBAGENTS_LIST_PARAMETERS.additionalProperties, false);
});
async function singleAgentManagerStub() {
  return {
    async run() {},
    async status() {},
    async result() {},
    async steer() {},
    async stop() {},
    async retry() {},
    async list() {},
  };
}

test("registers singleAgent in the workflow catalog and invokes one agent inside a named worktree", async () => {
  resetWorkflowRegistry();
  try {
    extension({ registerTool() {} }, { manager: await singleAgentManagerStub() });
    const catalog = loadingRegistry().catalogIndex();
    assert.ok(catalog.functions.some(({ name }) => name === "singleAgent"));
    const singleAgent = loadingRegistry().function("singleAgent");
    const calls = [];
    const context = {
      agent(prompt, options) { calls.push(["agent", prompt, options]); return Promise.resolve({ answer: "ok" }); },
      withWorktree(name, callback) { calls.push(["worktree", name]); return callback({ path: "/tmp/tree", branch: "branch" }); },
    };
    assert.deepEqual(await singleAgent.run({ prompt: "inspect", label: "review", worktree: "review-tree" }, context), { answer: "ok" });
    assert.deepEqual(calls, [
      ["worktree", "review-tree"],
      ["agent", "inspect", { label: "review" }],
    ]);
  } finally {
    resetWorkflowRegistry();
  }
});
test("invokes singleAgent through the registry with input and output schema validation", async () => {
  resetWorkflowRegistry();
  try {
    extension({ registerTool() {} }, { manager: await singleAgentManagerStub() });
    const calls = [];
    const results = new Map([["structured", { answer: "ok" }], ["scalar", "ok"], ["invalid-output", undefined]]);
    const context = { run: {}, invoke() {}, agent(prompt) { calls.push(prompt); return Promise.resolve(results.get(prompt)); } };
    const journal = { get() { return undefined; }, put() {} };
    await assert.rejects(
      loadingRegistry().invokeFunction("singleAgent", {}, context, "invalid-input", journal),
      (error) => error?.code === "RESULT_INVALID",
    );
    assert.deepEqual(await loadingRegistry().invokeFunction("singleAgent", { prompt: "structured" }, context, "structured", journal), { answer: "ok" });
    assert.equal(await loadingRegistry().invokeFunction("singleAgent", { prompt: "scalar" }, context, "scalar", journal), "ok");
    await assert.rejects(
      loadingRegistry().invokeFunction("singleAgent", { prompt: "invalid-output" }, context, "invalid-output", journal),
      (error) => error?.code === "RESULT_INVALID",
    );
    assert.deepEqual(calls, ["structured", "scalar", "invalid-output"]);
  } finally {
    resetWorkflowRegistry();
  }
});
test("keeps standalone tools available when the optional catalog name collides", async () => {
  resetWorkflowRegistry();
  try {
    registerWorkflowExtension({
      version: "1.0.0",
      headline: "Existing single agent",
      functions: { singleAgent: { description: "Existing function", input: { type: "object" }, output: { type: "string" }, run: () => "existing" } },
    });
    const tools = [];
    registerSubagentsExtension({ registerTool(tool) { tools.push(tool); } }, { manager: await singleAgentManagerStub() });
    assert.deepEqual(tools.map(({ name }) => name), toolNames);
    assert.equal(await loadingRegistry().function("singleAgent").run({}, {}), "existing");
  } finally {
    resetWorkflowRegistry();
  }
});
test("does not swallow unrelated invalid registry metadata", () => {
  resetWorkflowRegistry();
  const registry = loadingRegistry();
  const register = registry.register;
  registry.register = () => { throw new WorkflowError("INVALID_METADATA", "invalid registry metadata"); };
  try {
    assert.throws(() => registerSubagentsExtension({ registerTool() {} }), (error) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  } finally {
    registry.register = register;
    resetWorkflowRegistry();
  }
});
test("keeps standalone tools available when the workflow registry is frozen", async () => {
  resetWorkflowRegistry();
  try {
    loadingRegistry().freeze();
    const tools = [];
    registerSubagentsExtension({ registerTool(tool) { tools.push(tool); } }, { manager: await singleAgentManagerStub() });
    assert.deepEqual(tools.map(({ name }) => name), toolNames);
  } finally {
    resetWorkflowRegistry();
  }
});
test("publishes discoverable extension artifacts", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"]);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, encoding: "utf8" }));
  const paths = new Set(packed[0].files.map(({ path }) => path));
  assert.equal(paths.has("dist/index.js"), true);
  assert.equal(paths.has("README.md"), true);
  assert.equal(paths.has("package.json"), true);
  assert.equal([...paths].some((path) => path.startsWith("src/")), false);
});
async function executionContext(cwd, signal) {
  const models = [
    { provider: "fixture", id: "model" },
    { provider: "fixture", id: "cheap" },
    { provider: "fixture", id: "role-model" },
  ];
  return {
    cwd,
    model: { provider: "fixture", id: "model" },
    thinkingLevel: "medium",
    modelRegistry: { getAll: () => models, getAvailable: () => models },
    sessionManager: { getSessionId: () => "session-1" },
    isProjectTrusted: () => true,
    signal,
  };
}

async function managerContext(cwd) {
  return { toolCallId: "background", signal: undefined, extensionContext: await executionContext(cwd) };
}

test("runs one background subagent with context-derived setup and execution options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-run-success-"));
  const agentDir = join(cwd, "agent");
  await mkdir(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  await writeFile(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { cheap: "fixture/cheap" }, disabledAgentResources: { skills: ["global-skill"], extensions: ["global-extension"] } }));
  await mkdir(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ disabledAgentResources: { skills: ["project-skill"], extensions: ["project-extension"] } }));
  await writeFile(join(agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: fixture/role-model\nthinking: high\ntools: [read]\ndescription: Review work\n---\nReview carefully.");
  const sessionTransport = { id: "test", async createSession() { throw new Error("session should be supplied to the injected executor"); } };
  const controller = new AbortController();
  let root;
  let transport;
  let execution;
  const manager = createSubagentManager({
    agentDir,
    storageDir: join(cwd, "subagents-storage"),
    transport: sessionTransport,
    getActiveTools: () => ["read", "grep", "subagents_run"],
    createExecutor(nextRoot, nextTransport) {
      root = nextRoot;
      transport = nextTransport;
      return {
        async execute(task, options, signal) {
          execution = { task, options, signal };
          return { value: { answer: "ok" }, attempts: [], cwd: nextRoot.cwd };
        },
      };
    },
  });
  const runTool = createSubagentTools(manager)[0];
  const outputSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
  const context = await executionContext(cwd, controller.signal);
  const launch = await runTool.execute("call-1", { prompt: "inspect", label: "review", model: "cheap", thinking: "high", tools: ["read"], outputSchema, retries: 2, timeoutMs: 500 }, controller.signal, undefined, context);
  assert.equal(launch.details.state, "running");
  await waitFor(() => execution !== undefined);
  assert.equal(transport, sessionTransport);
  assert.equal(root.cwd, cwd);
  assert.deepEqual(root.model, { provider: "fixture", model: "model", thinking: "medium" });
  assert.deepEqual([...root.tools], ["read", "grep"]);
  assert.equal(root.modelAliases.cheap, "fixture/cheap");
  assert.deepEqual(root.agentResourcePolicy().global, { skills: ["global-skill"], extensions: [join(agentDir, "pi-extensible-workflows", "global-extension")] });
  assert.deepEqual(root.agentResourcePolicy().project, { skills: ["project-skill"], extensions: [join(cwd, ".pi", "pi-extensible-workflows", "project-extension")] });
  assert.deepEqual(root.agentResourcePolicy().effective, { skills: ["project-skill"], extensions: [join(cwd, ".pi", "pi-extensible-workflows", "project-extension")] });
  assert.equal(root.agentDefinitions.reviewer.model, "fixture/role-model");
  assert.equal(execution.task, "inspect");
  const { onAttempt, onProgress, ...options } = execution.options;
  assert.equal(typeof onAttempt, "function");
  assert.equal(typeof onProgress, "function");
  assert.deepEqual(options, { label: "review", workflowName: "subagents", model: "cheap", thinking: "high", tools: ["read"], schema: outputSchema, retries: 2, timeoutMs: 500 });
  assert.notEqual(execution.signal, controller.signal);
  assert.equal(root.runContext.runId, launch.details.id);
  await waitFor(async () => (await manager.status({ id: launch.details.id }, { toolCallId: "lookup", signal: undefined, extensionContext: context })).state === "completed");
  const roleLaunch = await runTool.execute("call-role", { prompt: "review", label: "role", role: "reviewer" }, controller.signal, undefined, context);
  await waitFor(() => execution?.task === "review");
  assert.equal(roleLaunch.details.state, "running");
  const { onAttempt: roleOnAttempt, onProgress: roleOnProgress, ...roleOptions } = execution.options;
  assert.equal(typeof roleOnAttempt, "function");
  assert.equal(typeof roleOnProgress, "function");
  assert.deepEqual(roleOptions, { label: "role", workflowName: "subagents", role: "reviewer" });
  await rm(cwd, { recursive: true, force: true });
});

test("preserves role exclusivity and persists a background execution failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-run-failure-"));
  const controller = new AbortController();
  let launches = 0;
  const manager = createSubagentManager({
    agentDir: join(cwd, "agent"),
    storageDir: join(cwd, "subagents-storage"),
    getActiveTools: () => ["read"],
    createExecutor() {
      return {
        async execute() {
          launches += 1;
          throw new Error("agent failed");
        },
      };
    },
  });
  const runTool = createSubagentTools(manager)[0];
  const extensionContext = await executionContext(cwd, controller.signal);
  const context = { toolCallId: "lookup", signal: undefined, extensionContext };
  await assert.rejects(runTool.execute("call-2", { prompt: "inspect", role: "reviewer", model: "fixture/cheap" }, controller.signal, undefined, extensionContext), (error) => error?.code === "INVALID_METADATA");
  assert.equal(launches, 0);
  const launched = await runTool.execute("call-3", { prompt: "inspect" }, controller.signal, undefined, extensionContext);
  await waitFor(async () => (await manager.status({ id: launched.details.id }, context)).state === "failed");
  assert.equal(launches, 1);
  assert.deepEqual(await manager.result({ id: launched.details.id }, context), { id: launched.details.id, error: { code: "AGENT_FAILED", message: "agent failed" } });
  await rm(cwd, { recursive: true, force: true });
});

test("discovers the package through its pi manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagents-extension-discovery-"));
  try {
    const destination = join(root, ".pi", "extensions", "subagents");
    await cp(packageRoot, destination, { recursive: true });
    const scopedModules = join(root, "node_modules", "@earendil-works");
    await mkdir(scopedModules, { recursive: true });
    for (const name of ["pi-ai", "pi-coding-agent"]) {
      await symlink(join(packageRoot, "../../..", "node_modules", "@earendil-works", name), join(scopedModules, name), "dir");
    }
    await symlink(join(packageRoot, "../../..", "node_modules", "typebox"), join(root, "node_modules", "typebox"), "dir");
    await symlink(join(packageRoot, "../../..", "node_modules", "pi-extensible-workflows"), join(root, "node_modules", "pi-extensible-workflows"), "dir");

    const result = await discoverAndLoadExtensions([], root, join(root, ".pi", "agent"));
    assert.equal(result.errors.length, 0);
    assert.equal(result.extensions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate, onTimeout) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await onTimeout?.();
  throw new Error("Timed out waiting for subagent state");
}

function deferredExecution(prompt, pending, started) {
  started.push(prompt);
  return new Promise((resolve, reject) => {
    pending.set(prompt, { resolve, reject });
  });
}

test("runs simultaneous background subagents and settles them independently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-concurrent-"));
  const storageDir = join(cwd, "subagents-storage");
  const pending = new Map();
  const started = [];
  const worktreeInputs = [];
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create(input) {
        worktreeInputs.push(input);
        return {
          path: join(cwd, `${input.name}-${input.runId}`),
          branch: `subagent/${input.name}-${input.runId}`,
          cwd,
          runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } },
          async cleanup() {},
        };
      },
    },
    createExecutor() {
      return {
        execute(prompt) {
          return deferredExecution(prompt, pending, started);
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "first", worktree: "one" }, context);
    const second = await manager.run({ prompt: "second", worktree: "two" }, context);
    assert.equal(first.state, "running");
    assert.equal(second.state, "running");
    await waitFor(() => started.length === 2);
    assert.deepEqual(new Set(started), new Set(["first", "second"]));
    await waitFor(() => worktreeInputs.length === 2);
    assert.deepEqual(worktreeInputs.map(({ name }) => name), ["one", "two"]);
    assert.notEqual(worktreeInputs[0].owner, worktreeInputs[1].owner);
    assert.equal((await manager.status({ id: first.id }, context)).state, "running");
    assert.equal((await manager.status({ id: second.id }, context)).state, "running");

    pending.get("first").resolve({ value: { answer: "one" }, attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: first.id }, context)).state === "completed");
    assert.equal((await manager.status({ id: second.id }, context)).state, "running");
    assert.deepEqual(await manager.result({ id: first.id }, context), { id: first.id, value: { answer: "one" } });
    assert.deepEqual(await manager.result({ id: first.id }, context), { id: first.id, value: { answer: "one" } });

    pending.get("second").resolve({ value: { answer: "two" }, attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: second.id }, context)).state === "completed");
    const listed = (await manager.list({}, context)).map(({ id, state }) => ({ id, state }));
    const expected = await Promise.all([first, second].map(async ({ id }) => ({ id, state: "completed", startedAt: JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8")).startedAt })));
    expected.sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    assert.deepEqual(listed, expected.map(({ id, state }) => ({ id, state })));
    const restarted = createSubagentManager({ storageDir });
    assert.equal((await restarted.status({ id: first.id }, context)).state, "completed");
    assert.deepEqual(await restarted.result({ id: first.id }, context), { id: first.id, value: { answer: "one" } });
    assert.deepEqual(await restarted.result({ id: first.id }, context), { id: first.id, value: { answer: "one" } });
  } finally {
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stopping one background subagent leaves another running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-stop-"));
  const pending = new Map();
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        execute(prompt, _options, signal) {
          return new Promise((resolve, reject) => {
            pending.set(prompt, { resolve, reject });
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "first" }, context);
    const second = await manager.run({ prompt: "second" }, context);
    assert.equal((await manager.stop({ id: first.id }, context)).state, "stopped");
    await waitFor(async () => (await manager.status({ id: first.id }, context)).state === "stopped");
    assert.equal((await manager.status({ id: second.id }, context)).state, "running");
    pending.get("second").resolve({ value: "second result", attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: second.id }, context)).state === "completed");
    assert.deepEqual(await manager.result({ id: second.id }, context), { id: second.id, value: "second result" });
  } finally {
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persists failed background subagents for repeatable lookup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-failure-"));
  const storageDir = join(cwd, "subagents-storage");
  const managerDependencies = {
    storageDir,
    createExecutor() {
      return {
        async execute() {
          throw new Error("agent failed");
        },
      };
    },
  };
  const context = await managerContext(cwd);
  try {
    const manager = createSubagentManager(managerDependencies);
    const launched = await manager.run({ prompt: "fail me", label: "failure" }, context);
    await waitFor(async () => (await manager.status({ id: launched.id }, context)).state === "failed");
    const expectedFailure = { code: "AGENT_FAILED", message: "agent failed" };
    assert.deepEqual(await manager.result({ id: launched.id }, context), { id: launched.id, error: expectedFailure });
    assert.deepEqual(await manager.result({ id: launched.id }, context), { id: launched.id, error: expectedFailure });

    const runDirectory = join(storageDir, launched.id);
    assert.equal((await stat(storageDir)).mode & 0o777, 0o700);
    assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(runDirectory, "request.json"))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(runDirectory, "request.json"), "utf8")), { prompt: "fail me", label: "failure" });
    assert.deepEqual(JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8")), expectedFailure);

    const restarted = createSubagentManager(managerDependencies);
    assert.equal((await restarted.status({ id: launched.id }, context)).state, "failed");
    assert.deepEqual(await restarted.result({ id: launched.id }, context), { id: launched.id, error: expectedFailure });
    assert.deepEqual((await restarted.list({}, context)).map(({ id, state }) => ({ id, state })), [{ id: launched.id, state: "failed" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("reconciles orphaned running records after a manager restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-orphan-"));
  const storageDir = join(cwd, "subagents-storage");
  const id = "11111111-1111-4111-8111-111111111111";
  const runDirectory = join(storageDir, id);
  const startedAt = Date.now() - 1000;
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "request.json"), JSON.stringify({ prompt: "orphan" }));
  await writeFile(join(runDirectory, "status.json"), JSON.stringify({ id, state: "running", startedAt }));
  const manager = createSubagentManager({ storageDir });
  const context = await managerContext(cwd);
  try {
    const status = await manager.status({ id }, context);
    assert.deepEqual(status, { id, state: "failed", error: { code: "INTERNAL_ERROR", message: "Subagent run was interrupted before completion" } });
    assert.deepEqual(await manager.result({ id }, context), { id, error: { code: "INTERNAL_ERROR", message: "Subagent run was interrupted before completion" } });
    assert.deepEqual((await manager.list({}, context)).map(({ id: listedId, state }) => ({ id: listedId, state })), [{ id, state: "failed" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queues steering until the executor registers its handler and flushes in order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-steering-before-handler-"));
  const started = deferred();
  const pending = deferred();
  let register;
  const delivered = [];
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        execute(_prompt, _options, _signal, setSteer) {
          register = setSteer;
          started.resolve();
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "steer me" }, context);
    await started.promise;
    await manager.steer({ id: run.id, message: "first" }, context);
    await manager.steer({ id: run.id, message: "second" }, context);
    await manager.steer({ id: run.id, message: "third" }, context);
    assert.deepEqual(delivered, []);
    register((message) => { delivered.push(message); });
    await waitFor(() => delivered.length === 3);
    assert.deepEqual(delivered, ["first", "second", "third"]);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: run.id }, context)).state === "completed");
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects steering after settlement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-steering-settled-"));
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "finish" }, context);
    await waitFor(async () => (await manager.status({ id: run.id }, context)).state === "completed");
    await assert.rejects(manager.steer({ id: run.id, message: "late" }, context));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop and steer race without affecting a sibling run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-stop-steer-race-"));
  const pending = new Map();
  const delivered = [];
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        execute(prompt, _options, signal, setSteer) {
          setSteer((message) => { delivered.push([prompt, message]); });
          return new Promise((resolve, reject) => {
            pending.set(prompt, { resolve, reject });
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "first" }, context);
    const second = await manager.run({ prompt: "second" }, context);
    await waitFor(() => pending.has("first") && pending.has("second"));
    await Promise.all([manager.steer({ id: first.id, message: "before-stop" }, context), manager.stop({ id: first.id }, context)]);
    await assert.rejects(manager.steer({ id: first.id, message: "after-stop" }, context));
    assert.equal((await manager.status({ id: first.id }, context)).state, "stopped");
    assert.equal((await manager.status({ id: second.id }, context)).state, "running");
    pending.get("second").resolve({ value: "second", attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: second.id }, context)).state === "completed");
    assert.equal(delivered.some(([prompt, message]) => prompt === "first" && message === "after-stop"), false);
  } finally {
    for (const item of pending.values()) item.reject(new Error("test cleanup"));
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persists latest progress, activity, usage, tool calls, and accounting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-progress-"));
  const storageDir = join(cwd, "subagents-storage");
  const pending = deferred();
  const accounting = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 };
  const toolCalls = [{ id: "tool-1", name: "read", state: "running" }];
  const manager = createSubagentManager({
    storageDir,
    createExecutor() {
      return {
        async execute(_prompt, options) {
          await options.onProgress?.({ accounting, toolCalls, activity: { kind: "tool", text: "read" }, lastEventAt: 123, persist: true });
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "progress" }, context);
    const status = await (async () => { await waitFor(async () => Boolean((await manager.status({ id: run.id }, context)).progress)); return manager.status({ id: run.id }, context); })();
    assert.deepEqual(status.accounting, accounting);
    assert.deepEqual(status.activity, { kind: "tool", text: "read" });
    assert.deepEqual(status.toolCalls, toolCalls);
    assert.deepEqual(status.usage, { tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 }, cost: 0.25 });
    assert.deepEqual(status.progress, { accounting, toolCalls, activity: { kind: "tool", text: "read" }, lastEventAt: 123 });
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: run.id }, context)).state === "completed");
    const restarted = createSubagentManager({ storageDir });
    assert.deepEqual((await restarted.status({ id: run.id }, context)).accounting, accounting);
    await restarted.dispose();
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delivers completion and failure through follow-up messages", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-notifications-"));
  const messages = [];
  const managerDependencies = {
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        async execute(prompt) {
          if (prompt === "failure") throw new Error("failed background work");
          return { value: "done", attempts: [], cwd };
        },
      };
    },
  };
  let shutdown;
  const registered = registerSubagentsExtension({
    registerTool() {},
    sendMessage(message, options) { messages.push({ message, options }); },
    on(name, handler) { if (name === "session_shutdown") shutdown = handler; },
  }, { managerDependencies });
  const context = await managerContext(cwd);
  try {
    const success = await registered.manager.run({ prompt: "success" }, context);
    const failure = await registered.manager.run({ prompt: "failure" }, context);
    await waitFor(async () => (await registered.manager.status({ id: success.id }, context)).state === "completed");
    await waitFor(async () => (await registered.manager.status({ id: failure.id }, context)).state === "failed");
    await waitFor(() => messages.length === 2);
    assert.deepEqual(messages.map(({ options }) => options), [{ deliverAs: "followUp", triggerTurn: true }, { deliverAs: "followUp", triggerTurn: true }]);
    assert.match(messages[0].message.content, /Subagent .* completed/);
    assert.match(messages[1].message.content, /Subagent .* failed/);
  } finally {
    await shutdown?.({ type: "session_shutdown", reason: "quit" }, context);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session shutdown disposes active subagent sessions and rejects controls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-shutdown-"));
  const storageDir = join(cwd, "subagents-storage");
  const pending = deferred();
  const sessionReady = deferred();
  const lifecycle = { abort: 0, dispose: 0 };
  let shutdown;
  const manager = createSubagentManager({
    storageDir,
    createExecutor() {
      return {
        async execute(_prompt, options, signal) {
          const session = {
            reference: { transport: "test", sessionId: "shutdown" },
            getState: () => ({ model: { provider: "fixture", model: "model" }, tools: [] }),
            getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
            getLastAssistant: () => undefined,
            subscribe: () => () => {},
            prompt: async () => {},
            steer: async () => {},
            async abort() { lifecycle.abort += 1; },
            async dispose() { lifecycle.dispose += 1; },
          };
          await options.onAttempt?.({ attempt: 1, transport: "test", liveSession: session, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: [], cwd } });
          sessionReady.resolve();
          signal.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
          return pending.promise;
        },
      };
    },
  });
  const registered = registerSubagentsExtension({ registerTool() {}, on(name, handler) { if (name === "session_shutdown") shutdown = handler; } }, { manager });
  const context = await managerContext(cwd);
  try {
    const run = await registered.manager.run({ prompt: "shutdown" }, context);
    await sessionReady.promise;
    await shutdown?.({ type: "session_shutdown", reason: "quit" }, context);
    assert.equal(lifecycle.abort, 1);
    assert.equal(lifecycle.dispose, 1);
    assert.equal((await registered.manager.status({ id: run.id }, context)).state, "stopped");
    await assert.rejects(registered.manager.steer({ id: run.id, message: "late" }, context));
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await registered.manager.dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("uses RunStore worktrees and removes them after a standalone run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-runstore-worktree-"));
  await writeFile(join(cwd, "README.md"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd });
  let worktreePath;
  let branch;
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor(root) {
      return {
        async execute(_task, options) {
          const reference = await root.runStore.validateWorktree(options.worktreeOwner);
          worktreePath = reference.cwd;
          branch = reference.branch;
          return { value: { cwd: reference.cwd }, attempts: [], cwd: reference.cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "work", worktree: "actual" }, context);
    await waitFor(async () => (await manager.status({ id: launched.id }, context)).state === "completed");
    assert.equal(typeof worktreePath, "string");
    await waitFor(async () => typeof worktreePath === "string" && !(await stat(worktreePath).then(() => true, () => false)));
    await waitFor(() => typeof branch === "string" && execFileSync("git", ["branch", "--list", branch], { cwd, encoding: "utf8" }).trim() === "");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("isolates concurrent real-git worktrees with the same name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-runstore-worktree-concurrent-"));
  await writeFile(join(cwd, "README.md"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd });
  const storageDir = join(cwd, "subagents-storage");
  const pending = deferred();
  const references = [];
  const manager = createSubagentManager({
    storageDir,
    createExecutor(root) {
      return {
        async execute(_task, options) {
          references.push(await root.runStore.validateWorktree(options.worktreeOwner));
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    let first;
    let second;
    const originalDateNow = Date.now;
    Date.now = () => 1234;
    try {
      first = await manager.run({ prompt: "first", worktree: "shared" }, context);
      second = await manager.run({ prompt: "second", worktree: "shared" }, context);
    } finally {
      Date.now = originalDateNow;
    }
    await waitFor(() => references.length === 2, async () => {
      const diagnostics = await Promise.all([first, second].map(async ({ id }) => {
        const status = await manager.status({ id }, context);
        const failure = await readFile(join(storageDir, id, "failure.json"), "utf8").catch((error) => `unavailable: ${error.message}`);
        return { id, status, failure };
      }));
      process.stderr.write(`Concurrent worktree diagnostics: ${JSON.stringify(diagnostics)}\n`);
      process.stderr.write(`Concurrent git worktrees:\n${execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })}`);
    });
    assert.notEqual(references[0].cwd, references[1].cwd);
    assert.notEqual(references[0].branch, references[1].branch);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: first.id }, context)).state === "completed" && (await manager.status({ id: second.id }, context)).state === "completed");
    await waitFor(async () => (await Promise.all(references.map(({ cwd: worktreeCwd }) => stat(worktreeCwd).then(() => true, () => false)))).every((exists) => !exists));
    await waitFor(() => references.every(({ branch }) => execFileSync("git", ["branch", "--list", branch], { cwd, encoding: "utf8" }).trim() === ""));
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("creates and cleans an injected named worktree for a subagent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-adapter-"));
  const storageDir = join(cwd, "subagents-storage");
  const created = [];
  let cleaned = 0;
  let capturedRoot;
  let capturedOptions;
  const adapter = {
    async create(input) {
      created.push(input);
      return {
        path: join(cwd, "worktree"),
        branch: "subagent/review",
        cwd: join(cwd, "worktree"),
        runStore: {
          async recordSystemPrompt() {},
          async validateWorktree() { return { path: join(cwd, "worktree"), branch: "subagent/review", cwd: join(cwd, "worktree"), owner: input.owner, base: "base" }; },
          async worktree() { return { path: join(cwd, "worktree"), branch: "subagent/review", cwd: join(cwd, "worktree"), owner: input.owner, base: "base" }; },
          async snapshotWorktree() { return "base"; },
        },
        async cleanup() { cleaned += 1; },
      };
    },
  };
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: adapter,
    createExecutor(root) {
      capturedRoot = root;
      return {
        async execute(_task, options) {
          capturedOptions = options;
          return { value: "done", attempts: [], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "work", worktree: "review" }, context);
    await waitFor(async () => (await manager.status({ id: launched.id }, context)).state === "completed");
    await waitFor(async () => JSON.parse(await readFile(join(storageDir, launched.id, "status.json"), "utf8")).worktreeContext === undefined);
    assert.equal(JSON.parse(await readFile(join(storageDir, launched.id, "status.json"), "utf8")).worktreeContext, undefined);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { cwd, sessionId: "session-1", runId: launched.id, name: "review", owner: "worktree/named/review" });
    assert.equal(capturedOptions.worktreeOwner, "worktree/named/review");
    assert.ok(capturedRoot.runStore);
    assert.deepEqual((await manager.status({ id: launched.id }, context)).worktree, { path: join(cwd, "worktree"), branch: "subagent/review" });
    assert.equal(cleaned, 1);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("persists worktree recovery context before adapter creation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-precreate-"));
  const storageDir = join(cwd, "storage");
  const createStarted = deferred();
  const releaseCreate = deferred();
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create(input) {
        createStarted.resolve(input);
        await releaseCreate.promise;
        return { path: join(cwd, "created-worktree"), branch: "subagent/created", cwd, runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } }, async cleanup() {} };
      },
    },
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "precreate", worktree: "precreate" }, context);
    const worktreeContext = await createStarted.promise;
    const persisted = JSON.parse(await readFile(join(storageDir, launched.id, "status.json"), "utf8"));
    assert.deepEqual(persisted.worktreeContext, worktreeContext);
    assert.equal(persisted.worktree, undefined);
    releaseCreate.resolve();
    await waitFor(async () => (await manager.status({ id: launched.id }, context)).state === "completed");
  } finally {
    releaseCreate.resolve();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("rejects empty standalone worktree names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-name-"));
  const manager = createSubagentManager({ storageDir: join(cwd, "storage"), worktreeAdapter: { async create() { throw new Error("should not create"); } } });
  try {
    await assert.rejects(manager.run({ prompt: "work", worktree: "   " }, await managerContext(cwd)), (error) => error?.code === "INVALID_METADATA");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("encodes standalone worktree names before persistence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-name-encoded-"));
  const names = ["nested/name", "..", "control\u0000name"];
  const created = [];
  const manager = createSubagentManager({
    storageDir: join(cwd, "storage"),
    worktreeAdapter: {
      async create(input) {
        created.push(input);
        return {
          path: join(cwd, `worktree-${created.length}`),
          branch: `subagent/${created.length}`,
          cwd,
          runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } },
          async cleanup() {},
        };
      },
    },
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    for (const name of names) {
      const run = await manager.run({ prompt: name, worktree: name }, context);
      await waitFor(async () => (await manager.status({ id: run.id }, context)).state === "completed");
    }
    assert.deepEqual(created.map(({ name, owner }) => ({ name, owner })), [
      { name: "nested/name", owner: "worktree/named/nested%2Fname" },
      { name: "..", owner: "worktree/named/.." },
      { name: "control\u0000name", owner: "worktree/named/control%00name" },
    ]);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("retries a failed subagent from its persisted request with a new ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-retry-"));
  let launches = 0;
  const manager = createSubagentManager({
    storageDir: join(cwd, "storage"),
    createExecutor() {
      return {
        async execute() {
          launches += 1;
          if (launches === 1) throw new Error("first attempt failed");
          return { value: { retry: true }, attempts: [], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const original = await manager.run({ prompt: "retry me", label: "retryable" }, context);
    await waitFor(async () => (await manager.status({ id: original.id }, context)).state === "failed");
    const retried = await manager.retry({ id: original.id }, context);
    assert.notEqual(retried.id, original.id);
    assert.equal(retried.state, "running");
    await waitFor(async () => (await manager.status({ id: retried.id }, context)).state === "completed");
    assert.deepEqual(await manager.result({ id: retried.id }, context), { id: retried.id, value: { retry: true } });
    assert.equal(launches, 2);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, "storage", retried.id, "request.json"), "utf8")), { prompt: "retry me", label: "retryable" });
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("retries an interrupted persisted subagent as a new run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-interrupted-retry-"));
  const storageDir = join(cwd, "storage");
  const id = "22222222-2222-4222-8222-222222222222";
  await mkdir(join(storageDir, id), { recursive: true });
  const cleanupCalls = [];
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "interrupted", worktree: "scope" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "running", startedAt: Date.now() - 10, worktreeContext: { cwd, sessionId: "session-1", runId: id, name: "scope", owner: "worktree/named/scope" } }));
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create() { return { path: join(cwd, "new-worktree"), branch: "new-branch", cwd, runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } }, async cleanup() {}, }; },
      async cleanup(input) { cleanupCalls.push(input); },
    },
    createExecutor() { return { async execute() { return { value: "recovered", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.status({ id }, context)).state, "failed");
    assert.deepEqual(cleanupCalls, [{ cwd, sessionId: "session-1", runId: id, name: "scope", owner: "worktree/named/scope" }]);
    const retried = await manager.retry({ id }, context);
    assert.notEqual(retried.id, id);
    await waitFor(async () => (await manager.status({ id: retried.id }, context)).state === "completed");
    assert.deepEqual(await manager.result({ id: retried.id }, context), { id: retried.id, value: "recovered" });
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("cleans a stopped persisted worktree during manager restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-stopped-worktree-recovery-"));
  const storageDir = join(cwd, "storage");
  const id = "66666666-6666-4666-8666-666666666666";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "stopped", owner: "worktree/named/stopped" };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "stopped", worktree: "stopped" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "stopped", startedAt: Date.now() - 10, finishedAt: Date.now(), worktreeContext }));
  const cleanupCalls = [];
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create() { throw new Error("unused"); },
      async cleanup(input) { cleanupCalls.push(input); },
    },
  });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.status({ id }, context)).state, "stopped");
    assert.deepEqual(cleanupCalls, [worktreeContext]);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("isolates failures while reconciling interrupted runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-isolation-"));
  const storageDir = join(cwd, "storage");
  const malformedId = "33333333-3333-4333-8333-333333333333";
  const cleanupId = "44444444-4444-4444-8444-444444444444";
  const healthyId = "55555555-5555-4555-8555-555555555555";
  const startedAt = Date.now() - 100;
  for (const id of [malformedId, cleanupId, healthyId]) await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, malformedId, "request.json"), JSON.stringify({ prompt: 42 }));
  await writeFile(join(storageDir, malformedId, "status.json"), JSON.stringify({ id: malformedId, state: "running", startedAt, worktreeContext: { cwd, sessionId: "session-1", runId: malformedId, name: "malformed", owner: "worktree/named/malformed" } }));
  await writeFile(join(storageDir, cleanupId, "request.json"), JSON.stringify({ prompt: "cleanup", worktree: "cleanup" }));
  await writeFile(join(storageDir, cleanupId, "status.json"), JSON.stringify({ id: cleanupId, state: "running", startedAt: startedAt + 1, worktreeContext: { cwd, sessionId: "session-1", runId: cleanupId, name: "cleanup", owner: "worktree/named/cleanup" } }));
  await writeFile(join(storageDir, healthyId, "request.json"), JSON.stringify({ prompt: "healthy" }));
  await writeFile(join(storageDir, healthyId, "status.json"), JSON.stringify({ id: healthyId, state: "running", startedAt: startedAt + 2 }));
  const cleanupCalls = [];
  let cleanupFailures = 0;
  const managerDependencies = {
    storageDir,
    worktreeAdapter: {
      async create() { throw new Error("unused"); },
      async cleanup(input) {
        cleanupCalls.push(input.runId);
        if (input.runId === cleanupId && cleanupFailures++ === 0) throw new Error("cleanup failed");
      },
    },
  };
  const manager = createSubagentManager(managerDependencies);
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.status({ id: malformedId }, context)).state, "failed");
    assert.equal((await manager.status({ id: cleanupId }, context)).state, "failed");
    assert.equal((await manager.status({ id: healthyId }, context)).state, "failed");
    assert.deepEqual(new Set(cleanupCalls), new Set([malformedId, cleanupId]));
    assert.equal(cleanupCalls.length, 2);
    const restarted = createSubagentManager(managerDependencies);
    assert.equal((await restarted.status({ id: malformedId }, context)).state, "failed");
    assert.equal(cleanupCalls.filter((id) => id === malformedId).length, 1);
    assert.equal(cleanupCalls.filter((id) => id === cleanupId).length, 1);
    await restarted.dispose();
    assert.deepEqual((await manager.list({}, context)).map(({ id, state }) => ({ id, state })), [
      { id: malformedId, state: "failed" },
      { id: cleanupId, state: "failed" },
      { id: healthyId, state: "failed" },
    ]);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("preserves completed results when persisted worktree cleanup fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-completed-cleanup-failure-"));
  const storageDir = join(cwd, "storage");
  const id = "77777777-7777-4777-8777-777777777777";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "completed", owner: "worktree/named/completed" };
  const status = { id, state: "completed", startedAt: Date.now() - 100, finishedAt: Date.now(), worktreeContext };
  const value = { preserved: true };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "completed" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify(status));
  await writeFile(join(storageDir, id, "result.json"), JSON.stringify(value));
  const manager = createSubagentManager({ storageDir, worktreeAdapter: { async create() { throw new Error("unused"); }, async cleanup() { throw new Error("cleanup failed"); } } });
  const context = await managerContext(cwd);
  try {
    assert.deepEqual(await manager.status({ id }, context), { id, state: "completed" });
    assert.deepEqual(await manager.result({ id }, context), { id, value });
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8")), status);
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, id, "result.json"), "utf8")), value);
    await assert.rejects(stat(join(storageDir, id, "failure.json")));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reconciles a running persisted result before throwing worktree cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-running-result-"));
  const storageDir = join(cwd, "storage");
  const id = "12121212-1212-4121-8121-121212121212";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "running-result", owner: "worktree/named/running-result" };
  const status = { id, state: "running", startedAt: Date.now() - 100, worktreeContext };
  const value = { preserved: true };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "running-result", worktree: "running-result" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify(status));
  await writeFile(join(storageDir, id, "result.json"), JSON.stringify(value));
  const manager = createSubagentManager({ storageDir, liveness: { isLive: () => false }, worktreeAdapter: { async create() { throw new Error("unused"); }, async cleanup() { throw new Error("cleanup failed"); } } });
  const context = await managerContext(cwd);
  try {
    assert.deepEqual(await manager.status({ id }, context), { id, state: "completed" });
    assert.deepEqual(await manager.result({ id }, context), { id, value });
    const persisted = JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8"));
    assert.equal(persisted.state, "completed");
    assert.deepEqual(persisted.worktreeContext, worktreeContext);
    await assert.rejects(stat(join(storageDir, id, "failure.json")));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("clears persisted worktree context after cleanup and retries failed cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-context-"));
  const storageDir = join(cwd, "storage");
  const id = "88888888-8888-4888-8888-888888888888";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "retry-cleanup", owner: "worktree/named/retry-cleanup" };
  const owner = { pid: 123, processStart: 1, sessionId: "live-session", token: "live-token", acquiredAt: Date.now() };
  const status = { id, state: "stopped", startedAt: Date.now() - 100, finishedAt: Date.now(), owner, worktreeContext };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "retry-cleanup", worktree: "retry-cleanup" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify(status));
  let cleanupCalls = 0;
  const adapter = {
    async create() { throw new Error("unused"); },
    async cleanup() { cleanupCalls += 1; if (cleanupCalls === 1) throw new Error("try again"); },
  };
  const context = await managerContext(cwd);
  const first = createSubagentManager({ storageDir, liveness: { isLive: () => true }, worktreeAdapter: adapter });
  try {
    assert.equal((await first.status({ id }, context)).state, "stopped");
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8")).worktreeContext, worktreeContext);
  } finally {
    await first.dispose();
  }
  const second = createSubagentManager({ storageDir, liveness: { isLive: () => true }, worktreeAdapter: adapter });
  try {
    assert.equal((await second.status({ id }, context)).state, "stopped");
    assert.equal(JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8")).worktreeContext, undefined);
    assert.equal(cleanupCalls, 2);
  } finally {
    await second.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reclaims a stale storage owner before reconciling persisted runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-stale-owner-"));
  const storageDir = join(cwd, "storage");
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "stale-owner", owner: "worktree/named/stale-owner" };
  const staleOwner = { pid: 123, processStart: 1, sessionId: "stale-session", token: "stale-token", acquiredAt: Date.now() - 1000 };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, "owner.json"), JSON.stringify(staleOwner));
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "stale-owner", worktree: "stale-owner" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "running", startedAt: Date.now() - 100, owner: staleOwner, worktreeContext }));
  const cleanupCalls = [];
  const manager = createSubagentManager({
    storageDir,
    liveness: { pid: 456, processStart: 2, sessionId: "new-session", isLive: () => false },
    worktreeAdapter: {
      async create() { throw new Error("unused"); },
      async cleanup(input) { cleanupCalls.push(input); },
    },
  });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.status({ id }, context)).state, "failed");
    assert.deepEqual(cleanupCalls, [worktreeContext]);
    const owner = JSON.parse(await readFile(join(storageDir, "owner.json"), "utf8"));
    assert.notEqual(owner.token, staleOwner.token);
    assert.equal(owner.sessionId, "new-session");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds storage-owner acquisition under owner-file churn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-owner-acquisition-bound-"));
  const storageDir = join(cwd, "storage");
  const ownerPath = join(storageDir, "owner.json");
  const initialOwner = { pid: 301, processStart: 1, sessionId: "churn-owner", token: "initial", acquiredAt: Date.now() - 1000 };
  await mkdir(storageDir, { recursive: true });
  await writeFile(ownerPath, JSON.stringify(initialOwner));
  let probes = 0;
  const manager = createSubagentManager({
    storageDir,
    liveness: { pid: 302, processStart: 2, sessionId: "bounded", token: "bounded", async isLive(owner) {
      probes += 1;
      await writeFile(ownerPath, JSON.stringify({ ...owner, token: `churn-${probes}` }));
      return false;
    } },
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "bounded" }, context);
    assert.equal(launched.state, "running");
    assert.equal(probes, 8);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a second live owner skips persisted-run reconciliation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-live-owner-"));
  const storageDir = join(cwd, "storage");
  const id = "99999999-9999-4999-8999-999999999999";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "live-owner", owner: "worktree/named/live-owner" };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "live-owner", worktree: "live-owner" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "running", startedAt: Date.now() - 100, worktreeContext }));
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let cleanupCalls = 0;
  const liveness = { pid: 123, processStart: 1, sessionId: "test-session", isLive: () => true };
  const adapter = {
    async create() { throw new Error("unused"); },
    async cleanup() { cleanupCalls += 1; cleanupStarted.resolve(); await releaseCleanup.promise; },
  };
  const first = createSubagentManager({ storageDir, liveness, worktreeAdapter: adapter });
  const context = await managerContext(cwd);
  try {
    await cleanupStarted.promise;
    const second = createSubagentManager({ storageDir, liveness, worktreeAdapter: adapter });
    try {
      assert.equal((await second.status({ id }, context)).state, "running");
      assert.equal(cleanupCalls, 1);
    } finally {
      await second.dispose();
    }
    releaseCleanup.resolve();
    assert.equal((await first.status({ id }, context)).state, "failed");
  } finally {
    releaseCleanup.resolve();
    await first.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("protects a run started without the storage lease from another manager", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-run-owner-protection-"));
  const storageDir = join(cwd, "storage");
  const sharedOwner = { pid: 900, processStart: 1, sessionId: "lease-owner", token: "shared-owner", acquiredAt: Date.now() };
  await mkdir(storageDir, { recursive: true });
  await writeFile(join(storageDir, "owner.json"), JSON.stringify(sharedOwner));
  const pending = deferred();
  const cleanupCalls = [];
  const adapter = {
    async create(input) {
      return {
        path: join(cwd, "worktree"),
        branch: "subagent/protected",
        cwd,
        runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } },
        async cleanup() { cleanupCalls.push(["run", input.runId]); },
      };
    },
    async cleanup(input) { cleanupCalls.push(["recovery", input.runId]); },
  };
  const manager = createSubagentManager({
    storageDir,
    liveness: { pid: 101, processStart: 2, sessionId: "manager-a", token: "manager-a", isLive: (owner) => owner.token === "shared-owner" },
    worktreeAdapter: adapter,
    createExecutor() { return { async execute() { return pending.promise; } }; },
  });
  const context = await managerContext(cwd);
  let second;
  try {
    const launched = await manager.run({ prompt: "protected", worktree: "protected" }, context);
    const statusFile = join(storageDir, launched.id, "status.json");
    await waitFor(async () => JSON.parse(await readFile(statusFile, "utf8")).worktreeContext !== undefined);
    const persisted = JSON.parse(await readFile(statusFile, "utf8"));
    assert.deepEqual(persisted.owner, { pid: 101, processStart: 2, sessionId: "manager-a", token: "manager-a", acquiredAt: persisted.owner.acquiredAt });
    await rm(join(storageDir, "owner.json"));
    second = createSubagentManager({
      storageDir,
      liveness: { pid: 202, processStart: 3, sessionId: "manager-b", token: "manager-b", isLive: (owner) => owner.token === "manager-a" },
      worktreeAdapter: adapter,
    });
    assert.equal((await second.status({ id: launched.id }, context)).state, "running");
    assert.deepEqual(cleanupCalls, []);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.status({ id: launched.id }, context)).state === "completed");
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await second?.dispose();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
