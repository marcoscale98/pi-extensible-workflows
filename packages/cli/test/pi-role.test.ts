/* eslint-disable @typescript-eslint/no-deprecated -- Regression coverage for promised legacy imports. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveRole } from "@piewf/pi-ext-roles/roles";
import { runPiRole, piArguments, resolvePiArguments } from "../src/pi-role.js";
import { readCliTestPackageMetadata } from "./support.js";
import { runPiRole as independentLauncher } from "@piewf/pi-ext-roles/launcher";

void test("legacy launcher import forwards the native CLI launcher, independently of deprecated argument projection", () => {
  assert.equal(runPiRole, independentLauncher);
  const manifest = readCliTestPackageMetadata(new URL("../../package.json", import.meta.url).pathname);
  assert.deepEqual(manifest.bin, { piewf: "./dist/src/cli.js" });
});

void test("forwarded launcher exercises native invalid-provider, help and session behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-role-forward-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "pi-ext-roles", "roles"), { recursive: true });
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "pi-ext-roles", "roles", "fixture.md"), "---\nmodel: fixture/model:medium\ncontextFiles: []\n---\nNative fixture\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", defaultProjectTrust: "never" }));
    writeFileSync(join(agentDir, "extensions", "fixture.js"), `export default pi => pi.registerProvider('fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] });`);
    const launcher = new URL("../src/pi-role.js", import.meta.url).href;
    const script = `import {runPiRole} from ${JSON.stringify(launcher)}; process.exitCode = await runPiRole(process.argv.slice(1), ${JSON.stringify(root)}, ${JSON.stringify(agentDir)});`;
    const env = { ...process.env, HOME: root, XDG_CACHE_HOME: join(root, "cache"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PATH: `${new URL("../../../../node_modules/.bin", import.meta.url).pathname}:${process.env.PATH ?? ""}` };
    const run = (args: string[], input = "") => spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", ...args], { cwd: root, encoding: "utf8", timeout: 30_000, env, input });
    const invalid = run(["fixture", "--model", "missing-provider/no-such-model", "-p", "--no-session"]);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /Unknown model|unavailable|not found/i);
    assert.doesNotMatch(invalid.stderr, /starting pi with its default model/);
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: pi-role/);
    assert.match(help.stdout, /--session/);
    const session = join(root, "native-session.jsonl");
    const rpc = run(["fixture", "--mode", "rpc", "--session", session], '{"id":"state","type":"get_state"}\n');
    assert.equal(rpc.status, 0, rpc.stderr);
    const state = rpc.stdout.split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as { id?: string; success?: boolean; data?: { sessionFile?: string; model?: { provider?: string } } }).find(response => response.id === "state");
    assert.equal(state?.success, true, rpc.stdout);
    assert.equal(state.data?.model?.provider, "fixture");
    assert.equal(state.data.sessionFile, session);
    // Native callable no-tools/wildcard regressions live in the sibling local-provider transport suite.
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("legacy projection preserves argv contract and rejects unsupported session settings", () => {
  const role = resolveRole(undefined, { cwd: "/unused", projectTrusted: false, selectorSources: { global: {}, project: {} }, modelAliases: {}, tools: ["read"], resources: { tools: ["read"], skills: ["review"], extensions: [] }, skills: ["review"], prompt: "Review" });
  assert.deepEqual(piArguments(role, new Map([["review", "/skills/review.md"]]), ["-p", "hi"]), ["--tools", "read", "--no-skills", "--skill", "/skills/review.md", "--no-extensions", "--append-system-prompt", "Review", "-p", "hi"]);
  assert.throws(() => piArguments({ ...role, contextFiles: ["global"] }, new Map(), []), /subset of context/);
  assert.throws(() => piArguments({ ...role, extensionSettings: {} }, new Map(), []), /does not support extensionSettings/);
  assert.ok(piArguments({ ...role, contextFiles: [] }, new Map(), []).includes("--no-context-files"));
});

void test("legacy resolver enumerates without executing factories, validates models and honors denied trust", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-role-legacy-"));
  const agentDir = join(root, "agent");
  try {
    const roles = join(agentDir, "pi-ext-roles", "roles");
    mkdirSync(roles, { recursive: true });
    mkdirSync(join(root, ".pi", "pi-ext-roles"), { recursive: true });
    writeFileSync(join(root, ".pi", "pi-ext-roles", "settings.json"), "invalid JSON");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "never.js"), 'throw new Error("extension factory executed");');
    writeFileSync(join(roles, "plain.md"), '---\ntools: ["!*", read]\n---\nReview');
    writeFileSync(join(roles, "invalid.md"), "---\nmodel: missing-alias\n---\nReview");
    writeFileSync(join(roles, "unknown.md"), "---\nmodel: nonexistent/no-such-model:off\n---\nReview");
    writeFileSync(join(roles, "extension-tool.md"), "---\ntools: [custom_extension_tool]\n---\nReview");
    writeFileSync(join(roles, "settings.md"), "---\nextensionSettings: { acme: { enabled: true } }\n---\nReview");
    const legacyRoles = join(agentDir, "pi-extensible-workflows", "roles");
    mkdirSync(legacyRoles, { recursive: true });
    writeFileSync(join(legacyRoles, "legacy.md"), "Legacy role");
    assert.ok((await resolvePiArguments("legacy", ["--no-approve"], root, agentDir)).includes("Legacy role"));
    const args = await resolvePiArguments("plain", ["--no-approve", "-p", "hi"], root, agentDir);
    assert.deepEqual(args.slice(0, 2), ["--tools", "read"]);
    assert.ok(args.includes(join(agentDir, "extensions", "never.js")));
    for (const name of ["invalid", "unknown"]) await assert.rejects(resolvePiArguments(name, ["--no-approve"], root, agentDir), /Unknown model|not available/);
    await assert.rejects(resolvePiArguments("extension-tool", ["--no-approve"], root, agentDir), /cannot enumerate extension tools/);
    await assert.rejects(resolvePiArguments("settings", ["--no-approve"], root, agentDir), /does not support extensionSettings/);
    writeFileSync(join(agentDir, "pi-ext-roles", "settings.json"), JSON.stringify({ extensionSettings: { acme: { enabled: true } } }));
    await assert.rejects(resolvePiArguments("plain", ["--no-approve"], root, agentDir), /does not support extensionSettings/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
