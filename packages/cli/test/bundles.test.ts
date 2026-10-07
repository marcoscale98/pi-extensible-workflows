import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { registerWorkflowExtension, resetWorkflowRegistry, type WorkflowExtension } from "pi-extensible-workflows";
import { runCli } from "../src/cli.js";
import { writePortableWorkflowBundle } from "../src/bundles.js";

type BundlePayload = { register: (registerWorkflowExtension: (extension: unknown) => void) => Promise<import("@piewf/pi-ext-roles").RoleDirectoryRegistration[]> };

void test("bundle loads extensions with aliased workflow API imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-"));
  const previousApi = (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
  try {
    const extension = join(root, "aliased-extension.mjs");
    writeFileSync(extension, [
      'import { registerWorkflowExtension as register } from "pi-extensible-workflows";',
      "export default function extension() {",
      '  register({ version: "1.0.0", headline: "Aliased extension", functions: {} });',
      "}",
      "",
    ].join("\n"));
    const source = join(root, "source-extension.mjs");
    writeFileSync(source, [
      'import { registerWorkflowExtension } from "pi-extensible-workflows";',
      "export default function extension() {",
      '  registerWorkflowExtension({ version: "1.0.0", headline: "Source extension", functions: { "bundle-test": { description: "Bundle test", input: { type: "object" }, output: { type: "string" }, run: (input) => input } } });',
      "}",
      "",
    ].join("\n"));
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({
      destination,
      command: "aliased-bundle",
      workflow: { name: "bundle-test", version: "1.0.0", headline: "Bundle test", description: "Bundle test", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(source).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
      resources: { extensions: [extension] },
    });

    const registered: unknown[] = [];
    (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = { registerWorkflowExtension: (value: unknown) => registered.push(value) };
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    await payload.register((value: unknown) => registered.push(value));

    assert.equal(registered.length, 2);
    assert.deepEqual(registered[0], { version: "1.0.0", headline: "Aliased extension", functions: {}, source: pathToFileURL(join(destination, "payload", "extensions", "aliased-extension.mjs")).href });
    assert.ok(registered.every(value => !Object.hasOwn(value as object, "roleDirectories")));
  } finally {
    if (previousApi === undefined) delete (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
    else (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = previousApi;
    rmSync(root, { recursive: true, force: true });
  }
});

void test("bundles an extension module with runtime and local lexical dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-source-"));
  const previousApi = (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
  try {
    const helper = join(root, "helper.mjs");
    writeFileSync(helper, 'export const suffix = "!";\n');
    const extension = join(root, "source-extension.mjs");
    writeFileSync(extension, [
      'import { Type } from "typebox";',
      'import { suffix } from "./helper.mjs";',
      'import { registerWorkflowExtension } from "pi-extensible-workflows";',
      'const prefix = "bundle:";',
      "function label(value) { return prefix + value; }",
      "const input = Type.Object({ value: Type.String() });",
      "export default function extension() {",
      '  registerWorkflowExtension({ version: "1.0.0", headline: "Source extension", functions: { sourceWorkflow: { description: "Source workflow", input, output: Type.String(), run(value) { return label(value.value) + suffix; } } } });',
      "}",
      "",
    ].join("\n"));
    const resource = join(root, "resource-extension.mjs");
    writeFileSync(resource, [
      'import { registerWorkflowExtension } from "pi-extensible-workflows";',
      "export default function resource() {",
      '  registerWorkflowExtension({ version: "1.0.0", headline: "Resource extension", functions: { resourceWorkflow: { description: "Resource workflow", input: { type: "object" }, output: { type: "string" }, run() { return "resource"; } } } });',
      "}",
      "",
    ].join("\n"));
    const destination = join(root, "bundle");
    const manifest = await writePortableWorkflowBundle({
      destination,
      command: "source-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source workflow", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      dependencies: ["typebox"],
      piVersion: "unknown",
      engineVersion: "unknown",
      resources: { extensions: [resource] },
    });
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.source, { module: "source-extension.mjs", export: "default" });
    assert.deepEqual(manifest.dependencies, ["typebox"]);
    assert.equal(typeof manifest.bundler?.esbuild, "string");
    const registered: Array<{ functions?: Record<string, { run: (input: { value: string }) => string }> }> = [];
    const api = { registerWorkflowExtension: (value: unknown) => registered.push(value as typeof registered[number]) };
    (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = api;
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    await payload.register(api.registerWorkflowExtension);
    assert.equal(registered.length, 2);
    assert.equal(registered.find((extension) => extension.functions?.resourceWorkflow)?.functions?.resourceWorkflow?.run({ value: "ok" }), "resource");
    assert.equal(registered.find((extension) => extension.functions?.sourceWorkflow)?.functions?.sourceWorkflow?.run({ value: "ok" }), "bundle:ok!");
  } finally {
    if (previousApi === undefined) delete (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
    else (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = previousApi;
    rmSync(root, { recursive: true, force: true });
  }
});

void test("bundle rejects Pi package imports even when declared", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-external-dependency-"));
  try {
    const extension = join(root, "external-extension.mjs");
    writeFileSync(extension, 'import { something } from "@earendil-works/pi-ai"; export default function () { return something; }\n');
    for (const dependencies of [undefined, ["@earendil-works/pi-ai"]]) {
      await assert.rejects(writePortableWorkflowBundle({
        destination: join(root, "bundle"),
        command: "external-bundle",
        workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
        source: { module: pathToFileURL(extension).href, export: "default" },
        ...(dependencies ? { dependencies } : {}),
        piVersion: "unknown",
        engineVersion: "unknown",
      }), /Pi packages \(@earendil-works\/\*\) cannot be bundled; use the pi-extensible-workflows API instead/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle rejects a source module without the selected export", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-export-"));
  try {
    const extension = join(root, "named-extension.mjs");
    writeFileSync(extension, "export function named() {}\n");
    await assert.rejects(writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "export-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    }), /does not export default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle reports when esbuild is not installed in the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-esbuild-"));
  const previousCwd = process.cwd();
  try {
    const extension = join(root, "source-extension.mjs");
    writeFileSync(extension, "export default function extension() {}\n");
    process.chdir(root);
    await assert.rejects(writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "missing-esbuild",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    }), /Install esbuild in the project/);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle rejects undeclared package imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dependency-"));
  try {
    const extension = join(root, "undeclared-extension.mjs");
    writeFileSync(extension, 'import { Type } from "typebox"; export default function () { void Type; }\n');
    await assert.rejects(writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "undeclared-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source workflow", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    }), /Undeclared dependencies: typebox/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle ignores dynamic import text in comments and strings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dynamic-text-"));
  try {
    const extension = join(root, "dynamic-text-extension.mjs");
    writeFileSync(extension, 'const text = "import(specifier)"; // import(specifier)\nexport default function extension() { return text; }\n');
    await writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "dynamic-text-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle rejects unsupported dynamic imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dynamic-"));
  try {
    const sources = {
      "dynamic-extension.mjs": 'export default function extension(specifier) { return import(specifier); }\n',
      "regex-extension.mjs": "const quote = /'/;\nexport default function extension(s) { return [quote, import(s)]; }\n",
    };
    for (const [name, source] of Object.entries(sources)) {
      const extension = join(root, name);
      writeFileSync(extension, source);
      await assert.rejects(writePortableWorkflowBundle({
        destination: join(root, "bundle"),
        command: "dynamic-bundle",
        workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source workflow", input: { type: "object" }, output: { type: "string" } },
        source: { module: pathToFileURL(extension).href, export: "default" },
        piVersion: "unknown",
        engineVersion: "unknown",
      }), new RegExp(`Unsupported dynamic import in .*${name}: dynamic imports must use a string-literal module path`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("bundle shim omits invalid emitted names", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-"));
  try {
    const extension = join(root, "invalid-extension.mjs");
    writeFileSync(extension, 'import { "invalid-name" as validName } from "pi-extensible-workflows";\n');
    const source = join(root, "source-extension.mjs");
    writeFileSync(source, "export default function extension() {}\n");
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({
      destination,
      command: "invalid-name-bundle",
      workflow: { name: "bundle-test", version: "1.0.0", headline: "Bundle test", description: "Bundle test", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(source).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
      resources: { extensions: [extension] },
    });

    const shim = readFileSync(join(destination, "payload", "node_modules", "pi-extensible-workflows", "index.mjs"), "utf8");
    assert.equal(shim, "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("bundle roundtrips extension settings, relocates provenance-relative selectors and captures independent contributions", async () => {
  const root = mkdtempSync(join(tmpdir(), "roles-bundle-"));
  const globals = globalThis as typeof globalThis & { __pi_bundle_api?: unknown; __pi_bundle_roles_api?: unknown };
  const previous = { api: globals.__pi_bundle_api, roles: globals.__pi_bundle_roles_api };
  try {
    const roleApi = await import("@piewf/pi-ext-roles");
    const resource = join(root, "selected.js");
    writeFileSync(resource, "export default () => {};\n");
    const source = join(root, "source.js");
    writeFileSync(source, `import { registerWorkflowExtension } from 'pi-extensible-workflows';
import { registerRoleContribution } from '@piewf/pi-ext-roles';
export default pi => {
  registerRoleContribution(pi, { owner: import.meta.url, roleDirectories: ['./roles'] });
  registerWorkflowExtension({ version: '1.0.0', headline: 'Roles bundle', source: import.meta.url, functions: { rolesBundle: { description: 'Role bundle', input: {type:'object'}, output: {type:'string'}, run: () => 'ok' } } });
};`);
    const rolePath = join(root, "reviewer.md");
    const role = roleApi.parseRoleMarkdown('---\nextensions: ["!*", "./selected.js"]\nextensionSettings: { acme: { enabled: true, nested: [null, 1] } }\ncontextFiles: [global]\noverrideSystemPrompt: true\n---\nReview', true, rolePath);
    role.provenance = { path: rolePath, scope: "global" };
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({ destination, command: "roles-bundle", workflow: { name: "rolesBundle", version: "1.0.0", headline: "Roles bundle", description: "Role bundle", input: { type: "object" }, output: { type: "string" } }, source: { module: pathToFileURL(source).href, export: "default" }, roles: { reviewer: role }, resources: { extensions: [resource] }, piVersion: "unknown", engineVersion: "unknown" });
    const bundledRolePath = join(destination, "payload", "roles", "reviewer.md");
    const restored = roleApi.parseRoleMarkdown(readFileSync(bundledRolePath, "utf8"), true, bundledRolePath);
    assert.deepEqual(restored.extensionSettings, role.extensionSettings);
    assert.match(readFileSync(bundledRolePath, "utf8"), /\.\.\/extensions\/selected\.js/);
    assert.deepEqual(restored.extensions, ["!*", join(destination, "payload", "extensions", "selected.js")]);
    restored.provenance = { path: bundledRolePath, scope: "extension" };
    const selected = join(destination, "payload", "extensions", "selected.js");
    const resolved = roleApi.resolveRole("reviewer", { cwd: root, agentDir: join(root, "agent"), projectTrusted: false, definition: structuredClone(restored), resources: { extensions: [selected] } });
    assert.deepEqual(resolved.selectedExtensions, [selected]);
    globals.__pi_bundle_api = {};
    globals.__pi_bundle_roles_api = roleApi;
    const registered: Array<{ roleDirectories?: string[] }> = [];
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    const sources = await payload.register(extension => registered.push(extension as { roleDirectories?: string[] }));
    assert.ok(registered.every(value => !Object.hasOwn(value, "roleDirectories")));
    assert.equal(sources.length, 1);
    assert.ok(sources[0]);
    assert.equal(sources[0].path, join(destination, "payload", "roles"));
    assert.equal(sources[0].owner, realpathSync(join(destination, "payload", "extension.mjs")));
  } finally {
    if (previous.api === undefined) delete globals.__pi_bundle_api; else globals.__pi_bundle_api = previous.api;
    if (previous.roles === undefined) delete globals.__pi_bundle_roles_api; else globals.__pi_bundle_roles_api = previous.roles;
    rmSync(root, { recursive: true, force: true });
  }
});

void test("packaged role reaches a headless CLI agent with its prompt and settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-agent-"));
  const globals = globalThis as typeof globalThis & { __pi_bundle_api?: unknown; __pi_bundle_roles_api?: unknown };
  const previous = { api: globals.__pi_bundle_api, roles: globals.__pi_bundle_roles_api };
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body) as { messages?: { role?: string }[] };
    requests.push(request);
    const submitting = request.messages?.at(-1)?.role !== "tool";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = submitting ? { role: "assistant", tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "workflow_result", arguments: JSON.stringify({ result: "Packaged reply" }) } }] } : { role: "assistant", content: "Submitted" };
    const chunk = { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] };
    const finish = { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: submitting ? "tool_calls" : "stop" }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  resetWorkflowRegistry();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "model", name: "Fixture", input: ["text"], contextWindow: 8192, maxTokens: 128 }] } } }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "model", cacheWarming: "off" }));
    const source = join(root, "source.mjs");
    writeFileSync(source, `import { registerWorkflowExtension } from "pi-extensible-workflows";
import { registerRoleContribution } from "@piewf/pi-ext-roles";
export default pi => { registerRoleContribution(pi, { owner: import.meta.url, roleDirectories: ["./contributed-roles"] }); registerWorkflowExtension({ version: "1.0.0", headline: "Agent bundle",
  agentSetupHooks: { check: { setup(agent, context) { if (context.settings.acme?.enabled !== true) throw new Error("Packaged settings missing"); agent.prompt += " SETTINGS_RECEIVED"; } } },
  functions: { packagedAgent: { description: "Packaged agent", input: { type: "object" }, output: { type: "string" }, async run(input, wf) { await wf.agent("Inspect", { role: "packaged" }); await wf.agent("Inspect again", { role: "contributed" }); return "ok"; } } }
}); };`);
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({ destination, command: "packaged", workflow: { name: "packagedAgent", version: "1.0.0", headline: "Agent bundle", description: "Packaged agent", input: { type: "object" }, output: { type: "string" } }, source: { module: pathToFileURL(source).href, export: "default" }, roles: { packaged: { prompt: "PACKAGED_ROLE_PROMPT", model: "fixture/model:off", tools: ["!*"], overrideSystemPrompt: true, extensionSettings: { acme: { enabled: true } } } } });
    // The contributor directory is distinct from the copied payload roles directory.
    mkdirSync(join(destination, "payload", "contributed-roles"));
    writeFileSync(join(destination, "payload", "contributed-roles", "contributed.md"), "---\nmodel: fixture/model:off\ntools: [\"!*\"]\noverrideSystemPrompt: true\nextensionSettings: {\"acme\":{\"enabled\":true}}\n---\nCONTRIBUTED_ROLE_PROMPT");
    globals.__pi_bundle_api = {};
    globals.__pi_bundle_roles_api = await import("@piewf/pi-ext-roles");
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    const roleSources = await payload.register(extension => {
      assert.ok(!Object.hasOwn(extension as object, "roleDirectories"));
      registerWorkflowExtension(extension as WorkflowExtension);
    });
    assert.ok(roleSources.some(({ path, scope, owner }) => path === join(destination, "payload", "contributed-roles") && scope === "extension" && owner === join(destination, "payload", "extension.mjs")));
    assert.ok(roleSources.some(({ path }) => path === join(destination, "payload", "roles")));
    let output = "";
    let stderr = "";
    const exit = await runCli(["run", "packagedAgent"], { cwd: root, agentDir, roleSources, stderr: text => { stderr += text; } }, text => { output += text; });
    assert.equal(exit, 0, stderr);
    assert.equal(output.trim(), '"ok"');
    assert.ok(requests.length >= 1);
    assert.match(JSON.stringify(requests[0]?.messages), /PACKAGED_ROLE_PROMPT/);
    assert.match(JSON.stringify(requests[0]?.messages), /SETTINGS_RECEIVED/);
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes("CONTRIBUTED_ROLE_PROMPT")));
  } finally {
    resetWorkflowRegistry();
    if (previous.api === undefined) delete globals.__pi_bundle_api; else globals.__pi_bundle_api = previous.api;
    if (previous.roles === undefined) delete globals.__pi_bundle_roles_api; else globals.__pi_bundle_roles_api = previous.roles;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => { resolve(); }));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("legacy workflow role registration fails with bundle migration guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-bundle-"));
  try {
    const source = join(root, "source.mjs");
    writeFileSync(source, `import { registerWorkflowExtension } from "pi-extensible-workflows";
export default () => registerWorkflowExtension({ version: "1.0.0", headline: "Legacy", roleDirectories: [], functions: { legacy: { description: "Legacy", input: { type: "object" }, output: { type: "string" }, run() { return "ok"; } } } });`);
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({ destination, command: "legacy", workflow: { name: "legacy", version: "1.0.0", headline: "Legacy", description: "Legacy", input: { type: "object" }, output: { type: "string" } }, source: { module: pathToFileURL(source).href, export: "default" } });
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    await assert.rejects(payload.register(() => assert.fail("Legacy registration reached workflow API")), /INVALID_METADATA.*registerRoleContribution.*re-export/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
