# pi-extensible-workflows

![pi-extensible-workflows workflow banner](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/assets/pi-extensible-workflows-banner.png)

> There are many workflow extensions but this one is **Yours.**

Turn multi-agent tasks into deterministic jobs that fan out in parallel, pause for approval, and resume without rerunning completed work.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Subagents](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) | [Herdr](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) | [Roles](https://vekexasia.github.io/pi-extensible-workflows/roles.html) | [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html) | [LLM guide](https://vekexasia.github.io/pi-extensible-workflows/llm.md) | [Video overview](https://youtu.be/qAiivspEHmU)

Requires Node.js 22.19 or newer. Every package here is trusted Pi host code with the same filesystem and process access as Pi. Install only code you trust.

## Choose the right path

| Need | Use |
| --- | --- |
| Coordinate multiple agents through deterministic stages, dependencies, approvals, and recovery | [`pi-extensible-workflows`](#install) |
| Launch one independent agent for a focused task without writing a workflow | [`@piewf/subagents`](#subagents) |
| Open live or completed workflow-agent sessions in Herdr panes | [`@piewf/herdr`](#herdr) |
| Inspect, run, export, or bundle registered workflows from a terminal | [`@piewf/cli`](#cli) |
| Add reusable host-side functions, model policy, hooks, actions, or packaged roles | [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html) |

## Install

Install the core workflow extension:

```sh
pi install npm:pi-extensible-workflows
```

Companion packages are installed separately:

| Package | Install | Relationship to core |
| --- | --- | --- |
| [`@piewf/subagents`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/extensions/subagents) | `pi install npm:@piewf/subagents` | Standalone single-shot agent tools; reuses workflow roles, settings, model aliases, and agent options. |
| [`@piewf/herdr`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/extensions/herdr) | `pi install npm:@piewf/herdr` | Companion integration for core workflow agents running inside Herdr. |
| [`@piewf/cli`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/cli) | `pi install npm:@piewf/cli` | Terminal operations and portable workflow export; installs the `piewf` command. |

For source installation and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).

## Quick start

Ask Pi to run a workflow. The main agent writes a named JavaScript script on demand; you do not need to maintain a workflow file for ordinary tasks.

```js
const reviews = await parallel("review", {
  correctness: () => agent("Review the current changes for correctness issues."),
  security: () => agent("Review the current changes for security risks."),
  tests: () => agent("Review the current changes for missing test coverage."),
});

return await agent(
  prompt("Summarize and prioritize these findings:\n\n{reviews}", { reviews }),
);
```

Launches require a non-empty `name` and exactly one of inline `script` or reviewed file-backed `scriptPath`. JSON-compatible `args` are available inside the script. Runs start in the background by default; set `foreground: true` when the final value must return in the same tool call.

## What the core provides

| Capability | Contract |
| --- | --- |
| Deterministic orchestration | `parallel(...)`, `pipeline(...)`, stable structural paths, and journaled results make replay predictable. |
| Durable runs | Run state, exact executed source, results, attempts, prompts, budgets, and worktree ownership are persisted. |
| Human gates | `checkpoint(...)` pauses a workflow until an exact approval or rejection is supplied. |
| Isolated development | `withWorktree(name, callback)` creates explicit named worktree scopes that agents and recovery can reuse. |
| Agent policy | Roles, model aliases, tool allow-lists, structured output, retries, timeouts, and resource exclusions share one validated configuration model. |
| Bounded execution | Per-run concurrency and optional aggregate token, cost, duration, and agent-launch budgets constrain work. |
| Recovery | Failed runs can retry from their completed journal; budget-exhausted runs can resume after an approved budget change. |
| Operations | `/workflow` and `/subagents`, the background widget, durable receipts, status tools, and `piewf` expose live and persisted state. |
| Extensibility | Trusted extensions can register reusable workflow functions, dynamic aliases, setup hooks, attempt actions, and role directories. |

## Execution and recovery

Workflow scripts run in a sandbox with no imports, filesystem, network, process, timers, or dynamic-code globals. Host work is explicit through agents, registered functions, worktrees, checkpoints, and the trusted `shell(...)` verification primitive.

Completed agent, shell, registered-function, and checkpoint operations are journaled. A failed run can therefore replay completed work and execute only incomplete paths. External side effects that happen before their result is journaled are not guaranteed exactly once.

| Operation | Tool |
| --- | --- |
| Launch a workflow | `workflow` |
| Inspect persisted state | `workflow_status` |
| Approve or reject a checkpoint or budget proposal | `workflow_respond` |
| Stop an active run | `workflow_stop` |
| Retry an explicitly failed run | `workflow_retry` |
| Continue a budget-exhausted run | `workflow_resume` |
| Discover registered functions and model aliases | `workflow_catalog`, when the active registry has entries |

Use `/workflow` for the interactive picker and run dashboard. Background completion or failure is delivered as one follow-up message. Foreground launches and recovery wait for the terminal value and include the completed run ID.

## Companion packages

### Subagents

`@piewf/subagents` is the lightweight path for single-shot agent work. Each run launches one independent agent session from one task. Single-shot describes the orchestration shape, not one model turn: the agent can use tools and accept steering while it runs.

```sh
pi install npm:@piewf/subagents
```

It exposes exactly five tools: `subagents_run`, `subagents_inspect`, `subagents_steer`, `subagents_stop`, and `subagents_retry`. Runs are backgrounded by default or can wait in foreground mode. Durable IDs, results, failures, progress, worktrees, and retries remain inspectable. Subagents reuse the same roles, role overrides, model aliases, settings, and agent options as workflows.

Read the [Subagents guide](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) or the [package reference](packages/extensions/subagents/README.md).

### Herdr

`@piewf/herdr` connects workflow agents to Herdr panes. It adds contextual `/workflow` actions for handing off a live agent session or opening a completed session, and can launch every workflow agent in a dedicated Herdr workspace in fully inspectable mode.

```sh
pi install npm:pi-extensible-workflows
pi install npm:@piewf/herdr
```

The integration activates only in a Herdr-managed pane and registers workflow actions and transport hooks, not model-facing tools. Read the [Herdr guide](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) or the [package reference](packages/extensions/herdr/README.md).

### CLI

`@piewf/cli` installs the `piewf` command for read-only diagnosis and inspection, headless registered-function execution, export, and portable bundles.

```sh
pi install npm:@piewf/cli
piewf doctor
piewf inspect
```

See [operations and debugging](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations) for the command reference and checkpoint limitations of headless execution.

## Roles and settings

Global workflow settings and roles live under `<agentDir>/pi-extensible-workflows/`, normally `~/.pi/agent/pi-extensible-workflows/`. Trusted projects may override supported settings and roles under `<cwd>/.pi/pi-extensible-workflows/`. Set `PI_CODING_AGENT_DIR` to move the agent directory.

Roles package stable model, thinking, tools, prompt, context-file, and resource policy. Calls can use a role name or a role override object. Subagents and workflows resolve the same role files and use the same validation rules.

- [Settings, model aliases, and resource exclusions](https://vekexasia.github.io/pi-extensible-workflows/developers.html#settings)
- [Role files and per-call customization](https://vekexasia.github.io/pi-extensible-workflows/roles.html)

## Extend workflows

Trusted Pi extensions can register reusable functions, dynamic model aliases, per-agent setup hooks, latest-attempt actions, and packaged role directories. Registered functions become validated globals inside workflow scripts and can compose other registered functions through `context.invoke(...)`.

Start with the [copy-paste extension template](packages/core/examples/workflow-extension-template/README.md), then use the [extension authoring reference](https://vekexasia.github.io/pi-extensible-workflows/extensions.html). The [bundled workflow skill](packages/core/skills/pi-extensible-workflows/SKILL.md) is the canonical agent-facing guide for workflow selection, authoring, and recovery.

## Documentation map

| Topic | Reference |
| --- | --- |
| Installation, tool API, DSL, budgets, lifecycle, and operations | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) |
| Single-shot agent tools and lifecycle | [Subagents guide](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) |
| Herdr handoff and fully inspectable mode | [Herdr guide](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) |
| Role files and overrides | [Roles guide](https://vekexasia.github.io/pi-extensible-workflows/roles.html) |
| Shipped extensions and extension authoring | [Extensions guide](https://vekexasia.github.io/pi-extensible-workflows/extensions.html) |
| LLM configuration and authoring reference | [LLM guide](https://vekexasia.github.io/pi-extensible-workflows/llm.md) |
| Run artifacts and lifecycle events | [Lifecycle reference](https://vekexasia.github.io/pi-extensible-workflows/developers.html#lifecycle) |
| Inspection and recovery | [Operations reference](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations) |

## Repository development

This repository is an npm-workspaces monorepo. `packages/core` publishes `pi-extensible-workflows`, `packages/cli` publishes `@piewf/cli`, and `packages/extensions/*` contains the published companion extensions. The private root keeps repository-wide commands consistent:

```sh
npm run build
npm run lint
npm test
npm run docs:check
npm run check
```

See [RELEASING.md](RELEASING.md) for the fixed-version release policy.

## License

MIT
