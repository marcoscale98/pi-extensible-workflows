import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalPath } from "../src/paths.js";
import { discoverRoles, loadRole, parseRoleMarkdown, resolveRole } from "@marcoscale98/pi-extensible-workflows/roles";

function directory(root: string, ...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}
function roleFile(root: string, scope: string, name: string, content: string): string {
  const dir = directory(root, scope, "pi-extensible-workflows", "roles");
  const path = join(dir, `${name}.md`);
  writeFileSync(path, content);
  return path;
}
function workflowErrorCode(error: unknown): unknown { return error && typeof error === "object" && "code" in error ? error.code : undefined; }

void test("roles use extension, global, and trusted project precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-roles-precedence-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const extensionDir = directory(root, "extension-roles");
  writeFileSync(join(extensionDir, "shared.md"), "---\ndescription: extension\n---\nextension");
  roleFile(agentDir, "", "shared", "---\ndescription: global\n---\nglobal");
  roleFile(cwd, ".pi", "shared", "---\ndescription: project\n---\nproject");
  const options = { cwd, agentDir, extensionRoleDirectories: [extensionDir] } as const;
  assert.equal(discoverRoles({ ...options, projectTrusted: true }).shared?.description, "project");
  assert.equal(discoverRoles({ ...options, projectTrusted: false }).shared?.description, "global");
});

void test("roles parse and resolve the complete frontmatter contract", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-roles-features-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const rolePath = roleFile(agentDir, "", "full", `---
model: role-model
description: Full role
tools: ["!*", read]
skills: ["foo*", "!foobar"]
extensions: ["**/*.mjs", "./keep.mjs", "!./skip.mjs"]
extensionSettings:
  acme:
    enabled: true
override_system_prompt: true
contextFiles: [global, project, cwd]
---
Role prompt`);
  const keep = join(dirname(rolePath), "keep.mjs");
  const skip = join(dirname(rolePath), "skip.mjs");
  mkdirSync(dirname(rolePath), { recursive: true });
  writeFileSync(keep, "");
  writeFileSync(skip, "");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { "role-model": "provider/model:high" }, skills: ["global-*"], tools: ["!*", "read", "write"] }));
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ skills: ["project-*"] }));
  const options = {
    cwd,
    agentDir,
    projectTrusted: true,
    extensionRoleDirectories: [],
    resources: {
      skills: ["global-skill", "project-skill", "foo", "foobar", "bar"],
      extensions: [keep, skip],
      tools: ["read", "write", "grep"],
    },
    knownModels: new Set(["provider/model", "other/override"]),
    availableModels: new Set(["provider/model", "other/override"]),
    tools: ["grep"],
    model: "other/override:low",
    contextFiles: ["cwd"],
    skills: ["bar", "missing-*"],
    extensions: ["!missing-extension"],
  } as const;
  const definition = loadRole("full", options);
  assert.deepEqual(definition, parseRoleMarkdown(`---
model: role-model
description: Full role
tools: ["!*", read]
skills: ["foo*", "!foobar"]
extensions: ["**/*.mjs", "./keep.mjs", "!./skip.mjs"]
extensionSettings:
  acme:
    enabled: true
override_system_prompt: true
contextFiles: [global, project, cwd]
---
Role prompt`, true, rolePath));
  const resolved = resolveRole("full", options);
  assert.deepEqual(resolved.model, { provider: "other", model: "override", thinking: "low" });
  assert.deepEqual(resolved.tools, ["read", "grep"]);
  assert.deepEqual(resolved.selectedSkills, ["global-skill", "project-skill", "foo", "bar"]);
  assert.deepEqual(resolved.selectedExtensions, [canonicalPath(keep)]);
  assert.deepEqual(resolved.unmatchedSkills, ["missing-*"]);
  assert.deepEqual(resolved.unmatchedExtensions, [`!${join(cwd, "missing-extension")}`]);
  assert.deepEqual(resolved.contextFiles, ["cwd"]);
  assert.deepEqual(resolved.systemPrompt, { mode: "override", text: "Role prompt" });
  assert.deepEqual(resolved.extensionSettings, { acme: { enabled: true } });
  assert.deepEqual(resolved.selectorLayers.skills, [["global-*"], ["project-*"], ["foo*", "!foobar"], ["bar", "missing-*"]]);
  assert.deepEqual(resolved.selectorLayers.extensions[2], ["**/*.mjs", canonicalPath(join(dirname(rolePath), "keep.mjs")), `!${canonicalPath(join(dirname(rolePath), "skip.mjs"))}`]);
  const suppliedDefinitions = discoverRoles(options);
  assert.deepEqual(resolveRole("full", { ...options, definitions: suppliedDefinitions }).selectorLayers.extensions[2], resolved.selectorLayers.extensions[2]);
  const withoutCandidates = resolveRole(undefined, { cwd, selectorSources: { global: {}, project: {} } });
  assert.equal(withoutCandidates.tools, undefined);
});

void test("role discovery rejects invalid frontmatter and rejected legacy fields", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-roles-invalid-"));
  const agentDir = join(root, "agent");
  roleFile(agentDir, "", "broken", "---\ncontextFiles: [repository]\n---\ninvalid");
  assert.throws(() => discoverRoles({ cwd: root, agentDir, projectTrusted: false, extensionRoleDirectories: [] }), (error: unknown) => workflowErrorCode(error) === "INVALID_METADATA");
  assert.throws(() => parseRoleMarkdown("---\nthinking: high\n---\ninvalid", true), (error: unknown) => workflowErrorCode(error) === "INVALID_METADATA");
  assert.throws(() => parseRoleMarkdown("---\ndisabledAgentResources: {}\n---\ninvalid", true), (error: unknown) => workflowErrorCode(error) === "INVALID_METADATA");
});
