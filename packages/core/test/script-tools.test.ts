import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { runWorkflow, WorkflowError } from "../src/index.js";
import { toolIdentityPath } from "../src/execution.js";
import { formatWorkflowProgress } from "../src/host-view.js";
import { listRunIds } from "../src/persistence.js";
import { prepareScriptToolLoadout, scriptToolValue } from "../src/script-tools.js";
import { scriptToolReferences } from "../src/validation.js";
import type { ExtensionToolContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import type { JsonValue, PersistedRun, ToolIdentity } from "../src/index.js";

type Tool = ExtensionToolContext["tools"][number];
type Outcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
const bashSchema = { type: "object", properties: { output: { type: "string" }, exit_code: { type: "number" } }, required: ["output", "exit_code"] };
const tool = (name: string, outputSchema?: object) => ({ name, label: name, description: `${name} tool`, parameters: { type: "object" }, ...(outputSchema ? { outputSchema } : {}), execute: () => Promise.reject(new Error("unused")) }) as unknown as Tool;
const outcome = (text: string, extra: { structuredContent?: JsonValue; isError?: boolean } = {}) => ({ toolCall: {}, result: { content: [{ type: "text", text }], details: {}, ...(extra.structuredContent === undefined ? {} : { structuredContent: extra.structuredContent }) }, isError: extra.isError ?? false }) as unknown as Outcome;

void test("workflow scripts call tools keyed by scope and arguments, and stay out of withWorktree", async () => {
  const calls: Array<[string, JsonValue, ToolIdentity]> = [];
  const result = await runWorkflow(`
    const first = await tools.read({ path: "a" });
    const [second, again] = await Promise.all([tools.read({ path: "b" }), tools.read({ path: "a" })]);
    const nested = await parallel("fan", { one: () => tools.read({ path: "c" }) });
    let blocked = "";
    try { await withWorktree("tree", async () => tools.read({ path: "d" })); } catch (error) { blocked = error.code; }
    let probe = "";
    try { "read" in tools; } catch (error) { probe = error.code; }
    return { first, second, again, nested, blocked, probe, thenable: tools.then === undefined };`, null, {
    tool: async (identifier, args, _signal, identity) => { calls.push([identifier, args, identity]); return `${identifier}:${args.path as string}`; },
    worktree: async () => ({ path: "/tmp/tree", branch: "tree" }),
  }).result;
  assert.deepEqual(result, { first: "read:a", second: "read:b", again: "read:a", nested: { one: "read:c" }, blocked: "INVALID_METADATA", probe: "INVALID_METADATA", thenable: true });
  assert.deepEqual(calls.map(([, args, identity]) => [args, identity]), [[{ path: "a" }, { structuralPath: [], occurrence: 1 }], [{ path: "b" }, { structuralPath: [], occurrence: 1 }], [{ path: "a" }, { structuralPath: [], occurrence: 2 }], [{ path: "c" }, { structuralPath: ["fan", "one"], occurrence: 1 }]]);
  const identity = { structuralPath: [], occurrence: 1 };
  assert.equal(toolIdentityPath("read", { a: 1, b: { c: 2, d: 3 } }, identity), toolIdentityPath("read", { b: { d: 3, c: 2 }, a: 1 }, identity), "key order does not change the journal path");
  assert.notEqual(toolIdentityPath("read", { path: "a" }, identity), toolIdentityPath("read", { path: "b" }, identity));
  await assert.rejects(runWorkflow("return await tools.read({});").result, (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("static tool references are known only when the script never rebinds tools", () => {
  assert.deepEqual(scriptToolReferences("const a = await tools.read({ path: 'x' }); return agent('p', { label: 'a', tools: ['read'] }).then(() => tools.bash({ command: 'ls' }));"), ["read", "bash"]);
  assert.equal(scriptToolReferences("const tools = ['read']; return tools.map((name) => name);"), undefined);
  assert.equal(scriptToolReferences("const tools = []; return agent('p', { label: 'a', tools });"), undefined);
  assert.equal(scriptToolReferences("return 'read' in tools;"), undefined);
});

void test("script tool values and model hints follow codemode", () => {
  assert.deepEqual(scriptToolValue(tool("bash", bashSchema), outcome("ok", { structuredContent: { output: "ok", exit_code: 1 } })), { output: "ok", exit_code: 1 });
  assert.equal(scriptToolValue(tool("read"), outcome("text")), "text");
  assert.throws(() => scriptToolValue(tool("bash", bashSchema), outcome("blocked", { isError: true })), (error: unknown) => error instanceof WorkflowError && error.code === "TOOL_FAILED" && error.message === "bash: blocked");
  assert.deepEqual(scriptToolValue(tool("bash", bashSchema), outcome("partial", { structuredContent: { output: "partial", exit_code: 2, missing: undefined } as unknown as JsonValue, isError: true })), { output: "partial", exit_code: 2 }, "an error with structured content resolves, normalized as the journal stores it");
  assert.throws(() => scriptToolValue(tool("read"), outcome("x".repeat(10 * 1024 * 1024 + 1))), (error: unknown) => error instanceof WorkflowError && error.code === "TOOL_FAILED" && error.message.includes("10 MB"));
  const loadout = (declared: Tool[]) => ({ declared, callable: declared, registered: declared, getExposure: () => "direct", getNamespace: () => undefined }) as unknown as ToolLoadout;
  assert.deepEqual(prepareScriptToolLoadout(loadout([tool("read"), tool("bash", bashSchema), tool("workflow_status", bashSchema)])), { descriptions: { bash: "bash tool\n\nWorkflow scripts: `tools.bash(args)` resolves to `{ output, exit_code }`." } });
  assert.equal(prepareScriptToolLoadout(loadout([tool("codemode"), tool("bash", bashSchema)])), undefined, "codemode's own lines describe the same calls");
});

void test("the workflow tool runs script tools, shows them while in flight, and a retry replays journaled calls", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-script-tools-"));
  const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ structuredContent?: unknown }> }> = [];
  workflowExtension(testExtensionApi({ registerTool: (definition) => { registered.push(definition as (typeof registered)[number]); }, getActiveTools: () => ["workflow"] }), home);
  const execute = (name: string) => { const found = registered.find((entry) => entry.name === name); assert.ok(found); return found.execute; };
  const executed: string[] = [];
  let bashFails = true;
  const ctx = {
    cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" },
    tools: [tool("read"), tool("bash", bashSchema), tool("workflow_status", bashSchema)],
    executeTool: async (name: string, args: { path?: string }) => {
      executed.push(name);
      if (name === "read") return outcome(`content of ${String(args.path)}`);
      return bashFails ? outcome("bash blocked", { isError: true }) : outcome("ran", { structuredContent: { output: "ran", exit_code: 0 } });
    },
  };
  await assert.rejects(execute("workflow")("unknown", { name: "unknown", script: "return tools.workflow_status({ runId: 'x' });", foreground: true }, new AbortController().signal, undefined, ctx), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL" && error.message.includes("tools.workflow_status"));
  assert.deepEqual(await listRunIds(home, "session", home, false), [], "an unknown tool fails the launch before the run exists");

  const updates: PersistedRun[] = [];
  const script = "const file = await tools.read({ path: 'a.txt' }); const sh = await tools.bash({ command: 'ls' }); return { file, exit: sh.exit_code };";
  await assert.rejects(execute("workflow")("first", { name: "tools", script, foreground: true }, new AbortController().signal, (update: { details: { run: PersistedRun } }) => { updates.push(update.details.run); }, ctx), (error: unknown) => error instanceof WorkflowError && error.code === "TOOL_FAILED");
  assert.deepEqual(executed, ["read", "bash"]);
  const inFlight = updates.find((run) => run.activeTools?.length);
  assert.ok(inFlight);
  assert.deepEqual(inFlight.activeTools?.map(({ name }) => name), ["read"]);
  assert.match(formatWorkflowProgress(inFlight, "◇"), /◇ tools \[running\] read elapsed=/);
  assert.equal(updates.at(-1)?.activeTools, undefined);

  bashFails = false;
  const [failedRunId] = await listRunIds(home, "session", home, false);
  assert.ok(failedRunId);
  const retried = await execute("workflow_retry")("retry", { runId: failedRunId, foreground: true }, new AbortController().signal, undefined, ctx);
  assert.deepEqual(retried.structuredContent, { runId: (retried.structuredContent as { runId: string }).runId, parentRunId: failedRunId, state: "completed", value: { file: "content of a.txt", exit: 0 } });
  assert.deepEqual(executed, ["read", "bash", "bash"], "the retry replays the journaled read and runs only the failed bash");
});
