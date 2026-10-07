import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deprecatedRoleSources, notifyRoleDeprecation } from "../src/role-deprecation.js";

void test("migration detection checks files and relevant field presence, never untrusted project paths", () => {
  const root = mkdtempSync(join(tmpdir(), "role-deprecation-"));
  const global = join(root, "agent", "pi-extensible-workflows");
  const project = join(root, ".pi", "pi-extensible-workflows");
  try {
    mkdirSync(join(global, "roles"), { recursive: true });
    mkdirSync(join(project, "roles"), { recursive: true });
    assert.deepEqual(deprecatedRoleSources(root, join(root, "agent"), true), []);
    writeFileSync(join(global, "roles", "ignore.txt"), "not a role");
    writeFileSync(join(global, "settings.json"), JSON.stringify({ concurrency: 2, retention: {} }));
    assert.deepEqual(deprecatedRoleSources(root, join(root, "agent"), true), []);
    writeFileSync(join(global, "settings.json"), JSON.stringify({ extensionSettings: { herdr: { enableFullyInspectableMode: false }, trajectory: { port: 8190 }, custom: { enabled: true } } }));
    assert.deepEqual(deprecatedRoleSources(root, join(root, "agent"), true), []);
    writeFileSync(join(project, "roles", "old.md"), "role");
    writeFileSync(join(project, "settings.json"), "{ invalid");
    assert.deepEqual(deprecatedRoleSources(root, join(root, "agent"), false), []);
    assert.deepEqual(deprecatedRoleSources(root, join(root, "agent"), true), [join(project, "roles", "old.md")]);
    writeFileSync(join(global, "settings.json"), JSON.stringify({ modelAliases: {}, tools: [], extensions: [], skills: [], extensionSettings: {} }));
    assert.equal(deprecatedRoleSources(root, join(root, "agent"), false).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("one TUI notice per actual session across callers and reload; RPC UI is not TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "role-notice-"));
  let id = "one";
  const messages: string[] = [];
  const context = { mode: "rpc", hasUI: true, cwd: root, sessionManager: { getSessionId: () => id }, ui: { notify: (message: string) => { messages.push(message); } } };
  try {
    mkdirSync(join(root, "pi-extensible-workflows", "roles"), { recursive: true });
    writeFileSync(join(root, "pi-extensible-workflows", "roles", "old.md"), "role");
    notifyRoleDeprecation(context, root);
    assert.equal(messages.length, 0);
    context.mode = "tui";
    notifyRoleDeprecation(context, root);
    notifyRoleDeprecation(context, root);
    const reloaded = await import("../src/role-deprecation.js");
    reloaded.notifyRoleDeprecation(context, root);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /old.md/);
    id = "two";
    notifyRoleDeprecation(context, root);
    assert.equal(messages.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
