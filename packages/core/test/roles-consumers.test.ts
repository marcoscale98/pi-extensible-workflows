import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { collectRoleContributions, registerRoleContribution } from "@piewf/pi-ext-roles";
import { parseRoleMarkdown as parsePublicRole } from "pi-extensible-workflows/roles";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import workflowExtension, { discoverRoles, loadRole, modelAliasErrorName, registerWorkflowExtension, resetWorkflowRegistry, resolveAgentResourcePolicy, resolveRole, resolveWorkflowSettings, RunStore, validateModelAliases, WorkflowError, WorkflowRegistry, workflowSettingsPath } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";
import { activeRoleDirectories, loadProjectAgentDefinitions } from "../src/roles.js";
import { decodeAgentDefinition, decodeLaunchSnapshot } from "../src/decoders.js";
import type { SessionInput } from "../src/agent-execution.js";
import { testExtensionApi } from "./support.js";
import { testTransport } from "./test-transport.js";

function write(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

void test("shared settings compose before explicit workflow overrides without empty defaults erasing them", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sharedGlobal = join(agentDir, "pi-ext-roles", "settings.json");
  const sharedProject = join(cwd, ".pi", "pi-ext-roles", "settings.json");
  const consumerGlobal = workflowSettingsPath(agentDir);
  try {
    write(sharedGlobal, JSON.stringify({ modelAliases: { global: "p/global:low" }, tools: ["!*", "read"], skills: [], extensionSettings: { acme: { shared: true } } }));
    write(sharedProject, JSON.stringify({ modelAliases: {}, tools: ["grep"] }));
    let settings = resolveWorkflowSettings(cwd, true, consumerGlobal);
    assert.deepEqual(settings.effective.modelAliases, {});
    assert.deepEqual(settings.effective.tools, ["!*", "read", "grep"]);
    assert.deepEqual(settings.effective.skills, []);
    assert.deepEqual(settings.effective.extensionSettings, { acme: { shared: true } });
    assert.equal(settings.sources.modelAliases, sharedProject);
    assert.deepEqual(resolveWorkflowSettings(cwd, false, consumerGlobal).effective.modelAliases, { global: "p/global:low" });
    write(consumerGlobal, JSON.stringify({ modelAliases: { override: "p/consumer:high" }, tools: ["!read"], extensionSettings: {} }));
    settings = resolveWorkflowSettings(cwd, true, consumerGlobal);
    assert.deepEqual(settings.effective.modelAliases, { override: "p/consumer:high" });
    assert.deepEqual(settings.effective.extensionSettings, { acme: { shared: true } });
    const policy = resolveAgentResourcePolicy(cwd, true, consumerGlobal);
    assert.deepEqual(policy.selectorSources.defaults?.global.tools, ["!*", "read"]);
    assert.deepEqual(resolveRole(undefined, { cwd, agentDir, rootTools: ["read", "grep"], selectorSources: policy.selectorSources, tools: ["read"] }).tools, ["read", "grep"]);
    assert.throws(() => resolveRole(undefined, { cwd, agentDir, rootTools: ["read"], inheritedTools: [], effectiveTools: ["read"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
    assert.deepEqual(new WorkflowRegistry().catalog({ cwd, projectTrusted: true, globalSettingsPath: consumerGlobal }).settings?.tools, settings.effective.tools);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("public adapter inherits shared aliases and selector defaults with explicit consumer overlays", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-overlays-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  try {
    write(join(agentDir, "pi-ext-roles/settings.json"), JSON.stringify({ modelAliases: { shared: "p/shared:low" }, tools: ["!*", "read"] }));
    const options = { cwd, agentDir, definition: { model: "shared" }, modelAliases: { other: "p/other:high" }, knownModels: new Set(["p/shared", "p/other"]), rootTools: ["read", "write", "grep"], selectorSources: { global: { tools: ["write"] }, project: {} } };
    assert.deepEqual(resolveRole("custom", options).model, { provider: "p", model: "shared", thinking: "low" });
    assert.deepEqual(resolveRole("custom", options).tools, ["read", "write"]);
    assert.deepEqual(resolveRole("custom", { ...options, tools: ["!read"] }).tools, ["write"]);
    assert.deepEqual(resolveRole("custom", { ...options, modelAliases: { shared: "p/other:high" } }).model, { provider: "p", model: "other", thinking: "high" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("public adapter composes shared and consumer namespaces below roles and explicit calls", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-precedence-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  const options = { cwd, agentDir, extensionRoleDirectories: [] };
  try {
    write(join(agentDir, "pi-ext-roles/settings.json"), JSON.stringify({ extensionSettings: { acme: { value: "shared", sharedOnly: true }, other: { kept: true } } }));
    assert.deepEqual(resolveRole(undefined, options).extensionSettings?.acme, { value: "shared", sharedOnly: true });
    write(workflowSettingsPath(agentDir), JSON.stringify({ extensionSettings: { acme: { value: "consumer" } } }));
    assert.deepEqual(resolveRole(undefined, options).extensionSettings?.acme, { value: "consumer" });
    const path = join(agentDir, "pi-ext-roles/roles/custom.md");
    write(path, '---\nextensionSettings: {"acme":{"value":"role"}}\n---\nRole');
    const definition = loadRole("custom", options);
    for (const supplied of [{}, { definition }, { definitions: { custom: definition } }]) {
      const resolved = resolveRole("custom", { ...options, ...supplied });
      assert.deepEqual(resolved.extensionSettings, { acme: { value: "role" }, other: { kept: true } });
      assert.deepEqual(resolved.definition, definition);
      assert.deepEqual(resolveRole("custom", { ...options, ...supplied, extensionSettings: { acme: { value: "call" } } }).extensionSettings, { acme: { value: "call" }, other: { kept: true } });
    }
    write(join(agentDir, "pi-ext-roles/settings.json"), "malformed");
    assert.deepEqual(resolveRole("custom", { ...options, definition, useSharedSettings: false, extensionSettings: { acme: { value: "call" } } }).extensionSettings, { acme: { value: "call" } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("new directories win within their scope and serializable provenance survives recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-provenance-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    write(join(agentDir, "pi-extensible-workflows", "roles", "custom.md"), "old global");
    write(join(agentDir, "pi-ext-roles", "roles", "custom.md"), "new global");
    write(join(cwd, ".pi", "pi-extensible-workflows", "roles", "custom.md"), "old project");
    const newPath = join(cwd, ".pi", "pi-ext-roles", "roles", "custom.md");
    write(newPath, "---\nextensions: [./selected.mjs]\nextensionSettings: {\"acme\":{\"enabled\":true}}\n---\nnew project");
    assert.equal(loadRole("custom", { cwd, agentDir, projectTrusted: false }).prompt, "new global");
    assert.equal(loadRole("custom", { cwd, agentDir }).prompt, "new project");
    const role = loadRole("custom", { cwd, agentDir });
    const snapshot = decodeLaunchSnapshot(JSON.parse(JSON.stringify({ script: "return null;", args: null, metadata: { name: "snapshot" }, settings: { concurrency: 1 }, models: [], tools: [], agentTypes: ["custom"], roles: { custom: role }, schemas: [] })));
    assert.deepEqual(snapshot?.roles?.custom, role);
    const recovered = snapshot.roles.custom;
    assert.ok(recovered);
    assert.equal(resolveRole("custom", { cwd: root, agentDir, definition: recovered }).selectorSources.role?.extensions?.[0], join(dirname(newPath), "selected.mjs"));
    assert.equal(decodeAgentDefinition({ provenance: { path: 2 } }), undefined);
    assert.equal(decodeAgentDefinition({ provenance: { path: newPath, scope: "invalid" } }), undefined);
    write(join(cwd, ".pi", "pi-ext-roles", "roles", "invalid.md"), "---\nextensionSettings: {\"trajectory\":{\"port\":70000}}\n---\nbad");
    assert.throws(() => discoverRoles({ cwd, agentDir }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("old API errors preserve WorkflowError identity and alias metadata", () => {
  assert.throws(() => validateModelAliases({ bad: "bad" }, "fixture.json"), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR" && modelAliasErrorName(error) === "bad");
  assert.throws(() => parsePublicRole("---\ntools: invalid\n---\nbad", true), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => loadRole("missing", { cwd: tmpdir(), projectTrusted: false, extensionRoleDirectories: [] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
});

void test("workflow role registration explicitly rejects all supplied values with migration guidance", () => {
  resetWorkflowRegistry();
  for (const roleDirectories of [undefined, [], ["/roles"], "invalid", Array(1)]) {
    const extension = { version: "1.0.0", headline: "Rejected", roleDirectories };
    for (const register of [registerWorkflowExtension, (value: typeof extension) => { new WorkflowRegistry().register(value); }]) {
      assert.throws(() => { register(extension); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && /registerRoleContribution from @piewf\/pi-ext-roles/.test(error.message));
    }
  }
});

void test("independent contributions enforce explicit membership and unsubscribe", () => {
  const bus = createEventBus(), owner = join(tmpdir(), "role-contributor.mjs");
  const unsubscribe = registerRoleContribution({ events: bus }, { owner: pathToFileURL(owner), roleDirectories: [join(tmpdir(), "roles")] });
  assert.deepEqual(activeRoleDirectories(bus), []);
  assert.deepEqual(collectRoleContributions(bus, []), []);
  assert.equal(collectRoleContributions(bus, [owner]).length, 1);
  unsubscribe();
  assert.deepEqual(collectRoleContributions(bus, [owner]), []);
});

void test("workflow launch uses shared role aliases, tools and extension settings at the actual transport", async () => {
  resetWorkflowRegistry();
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-host-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const inputs: SessionInput[] = [];
  let execute: (params: unknown, context: unknown) => Promise<unknown> = async () => { throw new Error("missing workflow tool"); };
  let shutdown: (() => Promise<unknown>) | undefined;
  try {
    write(join(agentDir, "pi-ext-roles", "settings.json"), JSON.stringify({ modelAliases: { selected: "fixture/model:high" }, tools: ["!*", "read"], extensionSettings: { acme: { shared: true } } }));
    write(join(agentDir, "pi-ext-roles", "roles", "custom.md"), "---\nmodel: selected\n---\nShared role");
    const transport = testTransport(async input => {
      inputs.push(input);
      return { sessionId: "shared", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, dispose() {} };
    });
    workflowExtension(testExtensionApi({ registerTool(tool) { if (tool.name === "workflow") { const run = tool.execute?.bind(tool); assert.ok(run); execute = (params, context) => run("call", params, new AbortController().signal, undefined, context); } }, on(name, handler) { if (name === "session_shutdown") shutdown = handler; }, getActiveTools: () => ["read", "grep", "workflow"] }), root, undefined, transport, agentDir);
    const context = { cwd, model: { provider: "fixture", id: "model" }, sessionManager: { getSessionId: () => "session" } };
    await execute({ name: "shared", script: 'return agent("inspect", { role: "custom" });', foreground: true }, context);
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0]?.model, { provider: "fixture", model: "model", thinking: "high" });
    assert.deepEqual(inputs[0].tools, ["read"]);
    assert.deepEqual(inputs[0].settings, { acme: { shared: true } });
    const ids = await listRunIds(cwd, "session", root);
    const runId = ids[0];
    assert.ok(runId);
    const persisted = await new RunStore(cwd, "session", runId, root).load();
    assert.deepEqual(persisted.run.agents[0]?.attemptDetails?.[0]?.setup.resourceSelectors?.selectorSources?.defaults?.global.tools, ["!*", "read"]);
    assert.equal(persisted.snapshot.roles?.custom?.provenance?.scope, "global");
    await execute({ name: "override", script: 'return agent("inspect", { role: "custom", model: "selected:low", tools: ["!*", "grep"] });', foreground: true }, context);
    assert.deepEqual(inputs[1]?.model, { provider: "fixture", model: "model", thinking: "low" });
    assert.deepEqual(inputs[1].tools, ["grep"]);
    write(join(cwd, ".pi", "pi-ext-roles", "settings.json"), JSON.stringify({ modelAliases: { selected: "untrusted/model:low" }, tools: ["!*", "grep"] }));
    await execute({ name: "untrusted", script: 'return agent("inspect", { role: "custom" });', foreground: true }, { ...context, isProjectTrusted: () => false });
    assert.deepEqual(inputs[2]?.model, { provider: "fixture", model: "model", thinking: "high" });
    assert.deepEqual(inputs[2].tools, ["read"]);
    // Each fresh launch captures the same namespace precedence used by resolveRole.
    write(workflowSettingsPath(agentDir), JSON.stringify({ extensionSettings: { acme: { value: "consumer" } } }));
    await execute({ name: "consumer-settings", script: 'return agent("inspect", { role: "custom" });', foreground: true }, { ...context, isProjectTrusted: () => false });
    assert.deepEqual(inputs[3]?.settings, { acme: { value: "consumer" } });
    write(join(agentDir, "pi-ext-roles", "roles", "custom.md"), '---\nmodel: selected\nextensionSettings: {"acme":{"value":"role"}}\n---\nShared role');
    await execute({ name: "role-settings", script: 'return agent("inspect", { role: "custom" });', foreground: true }, { ...context, isProjectTrusted: () => false });
    assert.deepEqual(inputs[4]?.settings, { acme: { value: "role" } });
    const roleIds = await listRunIds(cwd, "session", root);
    const snapshots = await Promise.all(roleIds.map(id => new RunStore(cwd, "session", id, root).load()));
    const roleSnapshot = snapshots.find(run => run.snapshot.metadata.name === "role-settings");
    assert.ok(roleSnapshot);
    assert.deepEqual(roleSnapshot.snapshot.settings.extensionSettings, { acme: { value: "consumer" } });
    assert.ok(roleSnapshot.snapshot.roles?.custom);
    assert.deepEqual(roleSnapshot.snapshot.roles.custom.extensionSettings, { acme: { value: "role" } });
  } finally { await shutdown?.(); resetWorkflowRegistry(); rmSync(root, { recursive: true, force: true }); }
});

void test("workflow factory contributes legacy scoped sources through the independent contribution API", async () => {
  resetWorkflowRegistry();
  const bus = createEventBus();
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-factory-"));
  const shutdown: Array<() => unknown> = [];
  const owner = fileURLToPath(new URL("../src/index.js", import.meta.url));
  try {
    workflowExtension(testExtensionApi({ events: bus, on(name, handler) { if (name === "session_shutdown") shutdown.push(handler); } }), root, undefined, undefined, root);
    assert.deepEqual(activeRoleDirectories(bus), []);
    assert.deepEqual(collectRoleContributions(bus, []), []);
    const contributions = collectRoleContributions(bus, [owner]);
    assert.ok(contributions.some(source => source.path === join(root, "pi-extensible-workflows", "roles") && source.scope === "global" && source.priority === 0));
    assert.ok(!contributions.some(source => source.path === join(root, "contributed")));
    for (const stop of shutdown) await stop();
    assert.deepEqual(collectRoleContributions(bus, [owner]), []);
  } finally { resetWorkflowRegistry(); rmSync(root, { recursive: true, force: true }); }
});

void test("project-only definitions ignore malformed global roles, report project scope and prefer new over legacy directories", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-consumers-project-only-"));
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    write(join(root, "agent", "pi-ext-roles", "roles", "broken-global.md"), "---\ntools: false\n---\nGLOBAL_MALFORMED");
    write(join(cwd, ".pi", "pi-extensible-workflows", "roles", "shared.md"), "---\ndescription: legacy\n---\nlegacy");
    write(join(cwd, ".pi", "pi-extensible-workflows", "roles", "legacy-only.md"), "legacy only");
    write(join(cwd, ".pi", "pi-ext-roles", "roles", "shared.md"), "---\ndescription: new\n---\nnew");
    const definitions = loadProjectAgentDefinitions(cwd);
    assert.deepEqual(Object.keys(definitions).sort(), ["legacy-only", "shared"]);
    assert.equal(definitions.shared?.prompt, "new");
    assert.equal(definitions.shared.provenance?.scope, "project");
    assert.equal(definitions["legacy-only"]?.provenance?.scope, "project");
    write(join(cwd, ".pi", "pi-ext-roles", "roles", "broken.md"), "---\ntools: false\n---\nbroken");
    assert.throws(() => loadProjectAgentDefinitions(cwd), /tools/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true }); }
});
