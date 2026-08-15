---
name: pi-extensible-workflows
description: Use when the task is complex enough to require multiple subagents or when the user explicitly asks for a workflow.
---

# pi-extensible-workflows

## Default path

Use `workflow` only for genuinely multi-agent orchestration; a single agent uses ordinary tools or `Agent` directly. Give phases distinct responsibilities and keep result flow explicit.

For most multi-agent tasks, start with a named inline workflow: provide a non-empty `name` and a `script` that fans out independent work with `parallel(...)`, awaits the keyed results, passes them into one summarizing `agent(...)`, and returns.

```js
const reports = await parallel("research", {
  first: () => agent("Research the first target."),
  second: () => agent("Research the second target."),
});

return await agent(
  prompt("Summarize these reports:\n\n{reports}", { reports }),
);
```

Await `parallel(...)` or `pipeline(...)` results before interpolation. Runs are backgrounded by default; set the tool-call `foreground: true` when the caller must wait for the final value. Use `/workflow` to open the picker and select a run for contextual actions such as moving an attached foreground workflow to the background.

## Runtime and safety rules

Functions returned by `workflow_catalog` are globals inside workflow source. Compose them with other workflow operations by calling them in `script`; pass their inputs through `args` when appropriate:
```js
// other code
const res = await fnName(args);
// consume res
return ...;
```

A reviewed JavaScript file on disk can use `scriptPath` instead of `script`.

Recovery map:
  - `workflow_status({ runId })` reads a compact authoritative summary for a run in the current project, across sessions; after failure follow-ups, especially `CANCELLED` or `interrupted`, call it before recovery or replacement work and pass its returned `state` as `expectedState`;
  - `agent(..., { retries })` reruns one agent call in the same run for transient failures;
  - `workflow_retry({ runId, expectedState?, foreground? })` replays a failed run into a child;
  - `workflow_resume({ runId, expectedState?, budget?, foreground? })` continues a `budget_exhausted` run;
  - recovery inherits the source snapshot's foreground/background launch mode, while legacy snapshots without `launchMode` recover in background; set `foreground: true` or `false` to override it;
  - `parentRunId` on a new launch only borrows named worktrees and never replays or resumes.

For an explicitly failed run, call `workflow_status({ runId })` first and pass its returned state as `expectedState` to `workflow_retry({ runId, expectedState, foreground: <prevValue> })`: diagnostics list replayable and incomplete paths, artifacts, and valid named worktrees; the tool creates a linked child, replays completed agent, shell, function, and checkpoint operations, and executes incomplete work. External side effects before failure are not guaranteed exactly once. After a `CANCELLED` or `interrupted` outcome, confirm whether the user accepted a recovery prompt before starting replacement work; a failure follow-up may have been queued before the original run resumed.
`workflow_stop` requires the exact run ID; `workflow_status({ runId })` returns only run metadata, state, delivery, budget/usage when configured, and agent summary shims, not transcripts or session payloads. Foreground launches and foreground recovery retain their terminal value and completed `runId`, while background launches and recovery return `runId` immediately and deliver completion or failure as a follow-up. Retry versus per-agent `retries` and `workflow_resume` is always explicit.
Inspect tool `workflow_catalog` result at least once before creating the first workflow for a task. Make sure to call workflow_catalog more than once if you need to inspect details about a global function.

Workflow JavaScript has no imports, filesystem, network, process, or timers. Delegate that work to agents. `shell(command, options)` is the trusted host RPC for deterministic gates: it inherits the workflow or active-worktree cwd, merges string `env` overrides, and returns `{ exitCode, stdout, stderr }`; nonzero exits are results, but launch failures and timeouts fail with `SHELL_FAILED`.

Example use of `shell`:

```js
// ... other code
const testRes = await shell("yarn test", { env: { CI: "1" } });
if (testRes.exitCode === 0) {
  // success path
  return { ok: true };
}
```

Most of the times using `shell()` to perform mutations is an antipattern. Use it mainly for verifications or idempotent actions.

## Advanced capabilities

Registered functions, `outputSchema`, budgets, checkpoints, worktrees, retry/resume, CLI export, and `pipeline(...)` remain available for workflows that need them. Treat these as advanced controls rather than requirements for the default inline path.

## `agent()` options

```typescript
export interface AgentOptions {
  label?: string;
  model?: string;
  role?: string;
  skills?: string[];
  extensions?: string[];
  tools?: string[];
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  outputSchema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  [key: string]: JsonValue;
}
```

Extensions may add JSON-compatible agent options such as `advisor: true`; core keys retain validation and role constraints. Extension options go to setup hooks/native setup and are not inherited by child agents.

Agent calls are unnamed. Direct calls receive hidden source call-site identity; aliases are unsupported, and calls from one source site must not race outside `parallel` or `pipeline`, whose structural keys make replay deterministic.

## Passing agent results

Use independent `agent(prompt, options)` calls and pass each completed result explicitly to the next prompt. This keeps workflow execution deterministic and makes replay state local to each call:

```js
const findings = await agent("Inspect the implementation.");
const fix = await agent(
  prompt("Propose the smallest fix from these findings:\n\n{findings}", {
    findings,
  }),
);
return { findings, fix };
```

Direct nested-agent results are one-shot: `get_subagent_result` releases the scheduler payload after successful delivery, and a repeated retrieval fails with `AGENT_RESULT_COLLECTED`. Retry only when the earlier tool call failed before delivering the result.

## Worktrees

Use `withWorktree(name, callback)` for top-level agents that collaborate in one explicitly named worktree scope:

```js
const result = await withWorktree("issue", async ({ path, branch }) => {
  const report = await agent("Implement the issue");
  return { path, branch, report };
});
```

Entering the scope materializes its worktree before the callback. The callback receives a frozen reference containing only the real string `path` and `branch`; callbacks may ignore the argument, and their bare return value is preserved. Concurrent agents share mutable files, so assign non-conflicting work or coordinate explicitly.

Branches may call any workflow function, not only `agent()`. Use separate named scopes when parallel branches need isolated worktrees:

```js
const results = await parallel("implementation", {
  api: () => withWorktree("api", () => agent("Implement the API")),
  ui: () => withWorktree("ui", () => agent("Implement the UI")),
});
```

Registered extension functions receive `withWorktree` in context and can compose other registered functions with `context.invoke("reviewRepository", { focus: "security" })`. Their public inputs and outputs remain JSON; callbacks cannot cross the extension boundary.

## Rules

- Use `log(messageString)` for brief operator status.
- A role can be a name string or an object with a required `name` and frontmatter overrides. Omitted fields inherit from the role file, `null` unsets them, and explicit values replace them. Top-level `skills`, `extensions`, and `tools` are final capability selector overlays; `model` and `thinking` remain role-only when a role is selected.
- Use `parallel()` for independent tasks with different flows and `pipeline()` when every keyed item follows the same ordered stages; do not duplicate identical chains in `parallel()`. Signatures are `parallel(operationName, tasksRecord)` and `pipeline(operationName, itemsRecord, stagesRecord)`; keys are stable task, item, and stage names.
- Preserve item metadata in workflow code between pipeline stages instead of making agents echo it through `outputSchema`.
- Use a JavaScript loop for repeated work; each direct `agent(...)` call gets deterministic call-site and occurrence identity.
- Runs default to background; set tool-call `foreground: true` when asked to wait.
- Add `budget` only for aggregate limits. Do not invent limits, omit if user do not ask explicitly. Valid dimensions are exactly `tokens`, `costUsd`, `durationMs`, and `agentLaunches`; each is `{ soft?: number, hard?: number }` with `soft < hard`.
- `budget_exhausted` runs resume through `workflow_resume`: omitted patch values stay unchanged, `null` removes a limit, and tightening resumes directly. Relaxation stores the exact proposal and returns `{ state: "awaiting_approval", proposalId }`; `workflow_respond` must answer that ID. Rejection leaves the run exhausted; approval applies the budget and cold-resumes it. `workflow_retry` is only for persisted `failed` runs and inherits cumulative usage; replay itself consumes no budget.
- `parallel()` and `pipeline()` return keyed bare values; await them before use. Interpolate results with `prompt("...{value}", { value })`; placeholders in plain strings remain literal.
- Use `outputSchema` only when another phase compares, aggregates, or validates a result, never for final prose. Keep only consumer-needed fields and avoid repeated evidence. Agents with it must call `workflow_result`; one repair prompt is built in. Omit `retries` unless an extra retry is justified and work is idempotent.
- Do not add persona specifications to agent prompts; define the task directly.
