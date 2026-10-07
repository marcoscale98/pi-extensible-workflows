import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { discoverRoles, resolveRole } from "@piewf/pi-ext-roles/roles";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { roleProjectSettingsPath, roleSettingsPath } from "@piewf/pi-ext-roles/settings";
import { localAgentTransport, prepareAgentSetupForInspection, WorkflowAgentExecutor, type AgentExecutionRoot } from "../src/agent-execution.js";
import { resolveAgentResourcePolicy, resolveWorkflowSettings, workflowSettingsPath } from "../src/settings.js";
import { WorkflowError, type SessionInput, type WorkflowAgentSession } from "../src/types.js";
import { testTransport } from "./test-transport.js";
import { testTransportContext } from "./support.js";

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "roles-captured-configuration-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  mkdirSync(cwd);
  const keptExtension = join(agentDir, "extensions", "kept.ts");
  const excludedExtension = join(agentDir, "extensions", "excluded.ts");
  const excludedMarker = join(dir, "excluded-ran");
  const settingsMarker = join(dir, "startup-settings.json");
  put(keptExtension, `import { writeFileSync } from "node:fs"; export default function(pi) { pi.on("session_start", event => { writeFileSync(${JSON.stringify(settingsMarker)}, JSON.stringify(event.settings)); }); }`);
  put(excludedExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(excludedMarker)}, "ran"); }`);
  for (const name of ["kept", "excluded"]) put(join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${name}`);
  put(join(agentDir, "auth.json"), "{}");
  put(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: ["frozen", "current"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1024, maxTokens: 128 })) } } }));
  const globalPath = roleSettingsPath(agentDir);
  const projectPath = roleProjectSettingsPath(cwd);
  put(globalPath, JSON.stringify({ tools: ["!*", "read"], skills: ["!*", "kept"], extensions: ["!*", keptExtension], modelAliases: { choice: "fixture/frozen:low" }, extensionSettings: { captured: { value: 1 } } }));
  put(projectPath, "{}");
  const consumerPath = workflowSettingsPath(agentDir);
  put(consumerPath, "{}");
  const captured = resolveWorkflowSettings(cwd, true, consumerPath);
  const policy = resolveAgentResourcePolicy(cwd, true, consumerPath);
  const root: AgentExecutionRoot = {
    cwd, agentDir, projectTrusted: true, model: { provider: "fixture", model: "frozen" },
    tools: new Set(["read", "write"]), availableModels: new Set(["fixture/frozen", "fixture/current"]),
    modelAliases: captured.effective.modelAliases ?? {}, resourceSelectors: { tools: captured.effective.tools ?? [] },
    extensionSettings: captured.effective.extensionSettings,
    agentDefinitions: { reviewer: { model: "choice", prompt: "Captured prompt", extensionSettings: { role: true } } },
    agentResourcePolicy: () => structuredClone(policy),
  };
  const change = () => {
    put(globalPath, JSON.stringify({ tools: ["!*", "write"], skills: ["!*", "excluded"], extensions: ["!*", excludedExtension], modelAliases: { choice: "fixture/current:high", fresh: "fixture/current:high" }, extensionSettings: { captured: false } }));
    put(projectPath, JSON.stringify({ tools: ["!read"], skills: ["!kept"], extensions: [`!${keptExtension}`] }));
  };
  const malform = () => { put(globalPath, "{ malformed"); put(projectPath, "[]"); };
  return { root, policy, cwd, agentDir, consumerPath, keptExtension, excludedMarker, settingsMarker, change, malform };
}

void test("executor uses captured selectors and aliases, while new launch/recovery composition stays live", t => {
  const f = fixture(t);
  const executor = new WorkflowAgentExecutor(f.root);
  const options = { label: "worker", workflowName: "flow", role: "reviewer" };
  const expected = executor.resolve(options);
  assert.deepEqual(expected.tools, ["read"]);
  assert.deepEqual(expected.model, { provider: "fixture", model: "frozen", thinking: "low" });
  f.change();
  assert.deepEqual(executor.resolve(options), expected);
  assert.deepEqual(executor.resolve(options, ["read", "write"]).tools, ["read"]);
  assert.throws(() => executor.resolve({ ...options, tools: ["write"] }, ["read"]), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ ...options, effectiveTools: ["write"] }, ["read"]), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ ...options, model: "fresh" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  const current = resolveWorkflowSettings(f.cwd, true, f.consumerPath);
  assert.equal(current.effective.modelAliases?.choice, "fixture/current:high");
  assert.deepEqual(current.effective.tools, ["!*", "write", "!read"]);
  f.malform();
  assert.deepEqual(executor.resolve(options), expected);
  assert.throws(() => resolveWorkflowSettings(f.cwd, true, f.consumerPath), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
});

void test("inspection and actual local resources/tools/model/settings stay captured through resume", async t => {
  const f = fixture(t);
  f.change();
  const prepared = await prepareAgentSetupForInspection(f.root, "work", { label: "worker", workflowName: "flow", role: "reviewer" }, localAgentTransport);
  assert.equal(prepared.failure, undefined);
  assert.deepEqual(prepared.setup.prepared.resourcePolicy?.selectorSources.defaults, f.policy.selectorSources.defaults);
  assert.deepEqual(prepared.setup.prepared.settings, { captured: { value: 1 }, role: true });
  assert.equal(Object.isFrozen(prepared.setup.prepared), true);
  let session: WorkflowAgentSession | undefined;
  try {
    session = await localAgentTransport.createSession(prepared.setup.prepared, { ...testTransportContext, settings: prepared.setup.prepared.settings ?? {} });
    const verify = () => {
      assert.ok(session);
      const state = session.getState();
      assert.deepEqual(state.tools, ["read"]);
      assert.deepEqual(state.model, { provider: "fixture", model: "frozen", thinking: "low" });
      assert.match(state.systemPrompt ?? "", /Captured prompt/);
      assert.ok(typeof session.getResourceInspection === "function");
      const inspection = session.getResourceInspection();
      assert.deepEqual(inspection.skills, ["kept"]);
      assert.deepEqual(inspection.extensions, [f.keptExtension]);
      assert.equal(existsSync(f.excludedMarker), false);
      assert.deepEqual(JSON.parse(readFileSync(f.settingsMarker, "utf8")), { captured: { value: 1 }, role: true });
    };
    verify();
    assert.ok(session.reference.locator);
    assert.ok(typeof session.suspendForHandoff === "function" && typeof session.resumeFromHandoff === "function");
    await session.suspendForHandoff();
    f.malform();
    await session.resumeFromHandoff();
    verify();
    const next = await prepareAgentSetupForInspection(f.root, "work", { label: "worker", workflowName: "flow", role: "reviewer" }, localAgentTransport);
    assert.equal(next.failure, undefined);
    assert.deepEqual(next.setup.prepared.model, prepared.setup.prepared.model);
    assert.deepEqual(next.setup.prepared.tools, prepared.setup.prepared.tools);
  } finally { await session?.dispose(); }
});

void test("execution retries prepare captured tools/model/resource policy/settings after settings become malformed", async t => {
  const f = fixture(t);
  const inputs: SessionInput[] = [];
  const transport = testTransport(async input => {
    inputs.push(input);
    const attempt = inputs.length;
    return {
      sessionId: `captured-${String(attempt)}`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt() { if (attempt === 1) { f.malform(); throw new Error("retry"); } },
      dispose() {},
    };
  });
  f.change();
  const executor = new WorkflowAgentExecutor(f.root, transport);
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", role: "reviewer", retries: 1 });
  assert.equal(result.value, "done");
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.deepEqual(input.tools, ["read"]);
    assert.deepEqual(input.model, { provider: "fixture", model: "frozen", thinking: "low" });
    assert.deepEqual(input.resourcePolicy?.selectorSources.defaults, f.policy.selectorSources.defaults);
    assert.deepEqual(input.settings, { captured: { value: 1 }, role: true });
  }
  assert.deepEqual(executor.resolve({ label: "after", workflowName: "flow", role: "reviewer" }).tools, ["read"]);
});

void test("independent resolved options reach a workflow-owned local SDK session and lifecycle", async t => {
  const f = fixture(t);
  put(join(f.agentDir, "AGENTS.md"), "GLOBAL_CONTEXT_ONLY");
  put(join(f.cwd, "AGENTS.md"), "PROJECT_CONTEXT_EXCLUDED");
  put(join(f.agentDir, "pi-ext-roles/roles/reviewer.md"), '---\nmodel: choice\ntools: ["!*", "read"]\nskills: ["!*", "kept"]\ncontextFiles: [global]\nextensionSettings: {"role":true}\n---\nIndependent role prompt');
  const definitions = discoverRoles({ cwd: f.cwd, agentDir: f.agentDir });
  f.root.agentDefinitions = definitions;
  const resolved = resolveRole("reviewer", { cwd: f.cwd, agentDir: f.agentDir, definitions, rootTools: [...f.root.tools], resources: { skills: ["kept", "excluded"], extensions: [f.keptExtension] } });
  assert.deepEqual(resolved.model, { provider: "fixture", model: "frozen", thinking: "low" });
  assert.deepEqual(resolved.tools, ["read"]);
  assert.deepEqual(resolved.selectedSkills, ["kept"]);
  assert.deepEqual(resolved.selectedExtensions, [f.keptExtension]);
  assert.deepEqual(resolved.contextFiles, ["global"]);
  assert.deepEqual(resolved.extensionSettings, { captured: { value: 1 }, role: true });
  assert.deepEqual(resolved.systemPrompt, { mode: "append", text: "Independent role prompt" });
  const shutdownMarker = join(f.agentDir, "shutdown");
  put(f.keptExtension, `import { writeFileSync } from "node:fs"; export default pi => { pi.on("session_start", event => writeFileSync(${JSON.stringify(f.settingsMarker)}, JSON.stringify(event.settings))); pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(shutdownMarker)}, "stopped")); };`);
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { Connection: "close", "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "frozen", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "frozen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve(); })); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  put(join(f.agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "frozen", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 128 }] } } }));
  const prepared = await prepareAgentSetupForInspection(f.root, "inspect", { label: "worker", workflowName: "flow", role: "reviewer" }, localAgentTransport);
  assert.equal(prepared.failure, undefined);
  assert.deepEqual(prepared.setup.prepared.model, resolved.model);
  assert.deepEqual(prepared.setup.prepared.tools, resolved.tools);
  assert.deepEqual(prepared.setup.prepared.contextFiles, resolved.contextFiles);
  assert.equal(prepared.setup.prepared.systemPromptAppend, resolved.prompt);
  assert.deepEqual(prepared.setup.prepared.settings, resolved.extensionSettings);
  const session = await localAgentTransport.createSession(prepared.setup.prepared, { ...testTransportContext, settings: prepared.setup.prepared.settings ?? {} });
  try {
    assert.deepEqual(session.getState().model, resolved.model);
    assert.deepEqual(session.getState().tools, resolved.tools);
    assert.equal(typeof session.getResourceInspection, "function");
    if (!session.getResourceInspection) throw new Error("missing resource inspection");
    const inspection = session.getResourceInspection();
    assert.deepEqual(inspection.skills, resolved.selectedSkills);
    assert.deepEqual(inspection.extensions, resolved.selectedExtensions);
    assert.deepEqual(JSON.parse(readFileSync(f.settingsMarker, "utf8")), resolved.extensionSettings);
    const prompt = session.getState().systemPrompt ?? "";
    assert.match(prompt, /Independent role prompt/);
    assert.match(prompt, /GLOBAL_CONTEXT_ONLY/);
    assert.doesNotMatch(prompt, /PROJECT_CONTEXT_EXCLUDED/);
    await session.prompt("inspect");
    assert.match(JSON.stringify(session.getLastAssistant()), /done/);
    assert.match(JSON.stringify(requests), /Independent role prompt/);
    assert.equal(existsSync(f.excludedMarker), false);
  } finally { await session.dispose(); }
  assert.equal(readFileSync(shutdownMarker, "utf8"), "stopped");
});
