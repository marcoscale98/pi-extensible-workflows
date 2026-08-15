import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSettings, parseRoleMarkdown, preflight, resolveWorkflowSettings, selectResources, WorkflowAgentExecutor, WorkflowError } from "../src/index.js";

void test("resource selectors use ordered last-match-wins rules", () => {
  const candidates = ["review-skill", "experimental-skill", "/opt/reviewer.mjs", "/opt/unsafe.mjs", "read", "write"];
  assert.deepEqual(selectResources(["review-*"], candidates), ["review-skill"]);
  assert.deepEqual(selectResources(["*", "!experimental-*"], candidates), ["review-skill", "/opt/reviewer.mjs", "/opt/unsafe.mjs", "read", "write"]);
  assert.deepEqual(selectResources(["!*", "review-*"], candidates), ["review-skill"]);
  assert.deepEqual(selectResources(["*", "!write", "write"], candidates), candidates);
});

void test("settings and roles expose direct selector fields", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-selectors-"));
  const globalPath = join(root, "settings.json");
  const cwd = join(root, "project");
  writeFileSync(globalPath, JSON.stringify({ skills: ["*", "!experimental-*"], extensions: ["**/*"], tools: ["*", "!write"] }));
  const settings = loadSettings(globalPath);
  assert.deepEqual(settings.skills, ["*", "!experimental-*"]);
  assert.deepEqual(settings.extensions, ["**/*"]);
  assert.deepEqual(settings.tools, ["*", "!write"]);
  assert.deepEqual(resolveWorkflowSettings(cwd, false, globalPath).effective.tools, ["*", "!write"]);
  const projectSettingsPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(projectSettingsPath, JSON.stringify({ skills: ["project-*"], extensions: ["!**/unsafe.mjs"], tools: ["!*", "read"] }));
  assert.deepEqual(resolveWorkflowSettings(cwd, true, globalPath).effective, { concurrency: 8, backgroundWidget: true, skills: ["*", "!experimental-*", "project-*"], extensions: ["**/*", "!**/unsafe.mjs"], tools: ["*", "!write", "!*", "read"] });
  assert.deepEqual(parseRoleMarkdown("---\nskills: [review-*]\nextensions: [\"**/*\"]\ntools: [\"!*\", read]\n---\nReview", true, join(root, "reviewer.md")), { prompt: "Review", skills: ["review-*"], extensions: ["**/*"], tools: ["!*", "read"] });
  const legacyPath = join(root, "legacy.json");
  writeFileSync(legacyPath, JSON.stringify({ disabledAgentResources: { skills: ["old"] } }));
  assert.throws(() => loadSettings(legacyPath), (error: unknown) => error instanceof WorkflowError);
});

void test("tool selectors cannot widen the root boundary", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep"]), resourceSelectors: { tools: ["!*", "read"] }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", tools: ["!*", "grep"] }).tools, ["grep"]);
  assert.throws(() => executor.resolve({ label: "agent", workflowName: "test", tools: ["!*", "/not-a-tool"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("positive capability layers preserve least privilege and parent boundaries", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep", "bash"]), resourceSelectors: { tools: ["*", "!bash"] }, agentDefinitions: { reviewer: { tools: ["read"] } }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", role: "reviewer" }).tools, ["read"]);
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", role: "reviewer", tools: ["grep"] }).tools, ["grep"]);
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", tools: [] }).tools, []);
});

void test("static selector validation is not skipped by dynamic options", () => {
  assert.throws(() => preflight("const label = process.env.LABEL; agent(\"x\", { tools: [1], label });", { models: new Set(["test/model"]), tools: new Set(["read"]), agentTypes: new Set() }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});
