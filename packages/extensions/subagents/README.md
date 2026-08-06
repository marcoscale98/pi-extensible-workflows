# `@piewf/subagents`

A Pi extension that exposes durable, namespaced subagent controls. It is the standalone manager API for launching several background agents at once; it also registers one optional workflow-catalog function for inline composition.

## Install and load

```sh
pi install npm:@piewf/subagents
```

Pi discovers the package through its `pi.extensions` manifest. The compiled entry point is `dist/index.js`. The package is trusted host code and runs with the same filesystem and process access as Pi.

The following host-integration sketch is pseudocode; Pi supplies `pi` and a host may supply the optional manager:

```ts
import extension, { type SubagentManager } from "@piewf/subagents";

const manager: SubagentManager = /* host implementation, or omit this option */;
extension(pi, { manager });
```

The default export registers the tools and the `singleAgent` workflow function. `createSubagentManager()` and `createSubagentTools()` are also exported for hosts that need explicit lifecycle or dependency injection. The manager is independent of the catalog function: standalone tools do not call or require a registered workflow function.

## Tools

Every tool schema is a closed object. Unknown properties are rejected.

| Tool | Input schema |
| --- | --- |
| `subagents_run` | `{ prompt: string, label?: string, model?: string, thinking?: string, tools?: string[], role?: string \| roleOverride, worktree?: string, outputSchema?: object, retries?: integer >= 0, timeoutMs?: positive integer \| null }` |
| `subagents_status` | `{ id: string }` |
| `subagents_result` | `{ id: string }` |
| `subagents_steer` | `{ id: string, message: string }` |
| `subagents_stop` | `{ id: string }` |
| `subagents_retry` | `{ id: string }` |
| `subagents_list` | `{}` |

`prompt` is the only required `subagents_run` property. A `role` string selects an existing workflow role. A role override object has `name` and optional `model`, `thinking`, `tools`, `description`, `overrideSystemPrompt`, `contextFiles`, and `disabledAgentResources` fields. A role request cannot also set `model`, `thinking`, or `tools`. `outputSchema` is a JSON Schema object passed to the agent result tool. Worktree names must be non-empty; surrounding whitespace is trimmed. `timeoutMs: null` disables an explicit timeout. The other option values use the same validation as the core workflow `agent` call.

## Launching and concurrency

`subagents_run` starts execution immediately and returns without waiting:

```json
{"id":"01900000-0000-4000-8000-000000000000","state":"running"}
```

The ID is a generated UUID. Each call owns an independent run, so multiple calls can execute concurrently and settle independently; there is no foreground wait mode or shared manager queue. A host can use `subagents_list` to inspect all records it can access. Completed and failed runs can also produce one follow-up message when the host supplies `sendMessage`; the message points to the ID rather than embedding the full result.

## IDs, status, and results

Run records are stored below the agent directory's private `subagents/` directory, normally `~/.pi/agent/subagents/<id>/`. The record includes the normalized request and status. A shared storage owner marker uses the process ID, process start, session ID, and token; every running record carries the same manager identity so a live manager does not reconcile another manager's active run.

`subagents_status` reports one of `running`, `completed`, `failed`, or `stopped`. It may also include the worktree path and branch, latest progress and activity, tool calls, token accounting, usage, and `lastEventAt`. Progress is retained in memory and is persisted when the executor marks a progress update for persistence.

`subagents_result` is repeatable and returns:

- `{ id, state: "running" }` while the run is active;
- `{ id, state: "stopped" }` after a stop;
- `{ id, value }` after completion; or
- `{ id, error: { code, message } }` after failure.

A failed record retains its failure file for later status and result reads. `subagents_list` returns status summaries ordered by start time.

## Steering and stopping

`subagents_steer` sends a message to a running agent. Messages sent before the executor exposes its steering handler are queued and delivered in order. The queue is bounded at 16 pending messages. Steering a settled, stopped, or unknown run fails; steering never targets a sibling run.

`subagents_stop` aborts only the selected run, clears its steering queue, persists `state: "stopped"`, aborts its active session, and cleans its worktree. Stopping one run does not stop other background runs. If the host aborts the launching tool-call signal instead, the executor cancellation is recorded as a `failed` run with a `CANCELLED` error and may produce a failure follow-up; use `subagents_stop` when the desired terminal state is `stopped`.

## Retries

`subagents_retry` is available for `failed` and `stopped` runs. It reads the original normalized request and starts a fresh execution with a new UUID. The old record and ID remain available. Completed or currently running runs are not retryable.

## Worktrees

Set `worktree` on `subagents_run` to create a named isolated Git worktree for that run. The default adapter uses the core `RunStore`; the executor runs in the worktree and status exposes its path and branch while materialized. Cleanup runs when the agent settles, stops, or the manager reconciles an interrupted record. A run ID keeps concurrent worktrees separate even when their names are the same.

## Roles and settings

The extension does not create a second settings or role system. It reuses `pi-extensible-workflows` settings, model aliases, disabled-resource policy, and role discovery:

- global roles: `<agentDir>/pi-extensible-workflows/roles/<name>.md`, normally `~/.pi/agent/pi-extensible-workflows/roles/`;
- trusted project roles: `<cwd>/.pi/pi-extensible-workflows/roles/<name>.md`;
- global and trusted project settings: the normal workflow settings path under the agent directory and `<cwd>/.pi/pi-extensible-workflows/settings.json`.

The current Pi model, thinking level, active tools, project trust, session ID, role definitions, aliases, and resource policy are captured from the extension context for each run. Internal workflow and subagent control tools are not exposed to the child agent.

## Workflow catalog integration

The extension registers `singleAgent` as a thin workflow function under the core process-global function registry. It uses the same `subagents_run` request normalization and calls the core `context.agent` exactly once. If another extension already owns the generic `singleAgent` name, catalog registration is skipped so the seven standalone tools still load; use the standalone API or rename the other function. It is useful when a normal workflow script needs one inline agent while retaining the same role, model, thinking, tools, retries, timeout, output-schema, and label options:

```js
return await singleAgent({
  prompt: "Review the changed files.",
  role: "reviewer",
  outputSchema: { type: "object", properties: { findings: { type: "array" } } },
});
```

For a named worktree, the function uses the core scope form and does not pass the worktree reference as an agent prompt or option:

```js
return await singleAgent({
  prompt: "Implement the fix.",
  worktree: "fix",
});
```

`singleAgent` is inline workflow composition, not a replacement for the standalone background manager. It returns the agent's JSON value directly and does not create a `subagents_*` ID, durable manager result, follow-up notification, or cross-session restoration point.

## Shutdown and restoration

The default extension subscribes to `session_shutdown`. Disposal aborts active runs, disposes owned agent sessions and listeners, cleans active worktrees, waits for pending completion notifications, releases the storage owner, and is idempotent. Terminal records and results remain on disk. Terminal worktree cleanup context is retained when cleanup fails and retried on a later manager startup; successful cleanup clears the persisted context.

**Cross-session restoration of a live native subagent session is unsupported.** On a new manager, a persisted `running` record is reconciled to `failed` with an interruption error unless a result or failure was already persisted. Use `subagents_retry` to start a new run; it does not restore conversation context or reuse the old native session. Persisted completed and failed records remain readable, subject to the storage owner and filesystem being available.

## Migrating from `@tintinweb/pi-subagents`

Install this package alongside the core workflow extension instead of the old package:

```sh
pi remove npm:@tintinweb/pi-subagents
pi install npm:@piewf/subagents
```

| Old API or feature | `@piewf/subagents` equivalent |
| --- | --- |
| `Agent({ prompt, description, subagent_type, run_in_background: true })` | `subagents_run({ prompt, label, role })`; runs are background by design. |
| `get_subagent_result({ agent_id })` | `subagents_status({ id })` for lifecycle, then `subagents_result({ id })` for the value. |
| `steer_subagent({ agent_id, message })` | `subagents_steer({ id, message })`. |
| UI or abort-based stopping | `subagents_stop({ id })`. |
| `resume` or native session continuation | Not supported across sessions; use `subagents_retry({ id })` for a fresh run with a new ID. |
| `.pi/agents` custom agent types | Workflow role files under `pi-extensible-workflows/roles/`, or per-call `role` and role overrides. |
| old subagent settings, widget, FleetView, schedules, memory, event-bus RPC, and output transcripts | Not part of this extension's API. Use core workflow settings, core lifecycle APIs, or a separate extension where applicable. |

The new manager deliberately keeps durable run IDs, repeatable results, bounded steering, named worktree cleanup, and workflow role/settings reuse. It does not promise feature-for-feature compatibility with the old UI-oriented extension.
