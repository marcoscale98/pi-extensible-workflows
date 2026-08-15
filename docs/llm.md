# pi-extensible-workflows

> Trusted Pi packages for deterministic workflows, standalone subagents, Herdr integration, reusable roles, and extension capabilities.

This file is the compact package-selection, configuration, extension-authoring, and role-authoring reference for an LLM. It is intentionally not a workflow-language guide. Do not invent workflow scripts, orchestration patterns, or recovery procedures from this file. For workflow authoring, use the bundled skill at `packages/core/skills/pi-extensible-workflows/SKILL.md`.
## Install and trust

Requirements:

- Node.js 22.19 or newer.
- A trusted Pi installation and trusted project. These packages are trusted code with the same filesystem and process access as Pi.

Install the core workflow extension for deterministic orchestration:

```sh
pi install npm:pi-extensible-workflows
```

Install companion packages only for the capability you need:

```sh
pi install npm:@piewf/subagents
pi install npm:@piewf/herdr
pi install npm:@piewf/cli
```

| Package | Select it when |
| --- | --- |
| `pi-extensible-workflows` | The task needs a deterministic script, multiple agents or stages, approvals, budgets, worktrees, replay, or resume. |
| `@piewf/subagents` | The task needs one independent agent run with a durable ID and lifecycle controls, without a workflow script. It works standalone. |
| `@piewf/herdr` | Core workflow agents need live handoff, completed-session inspection, or fully inspectable execution in Herdr. Core must also be loaded. |
| `@piewf/cli` | A terminal needs doctor, inspection, headless registered-function execution, export, or bundle commands. |

For local development:

```sh
git clone https://github.com/vekexasia/pi-extensible-workflows.git
cd pi-extensible-workflows
npm ci
npm run check
pi install "$PWD/packages/core"
```

A one-session source run is:

```sh
pi --no-extensions --extension "$PWD/packages/core/src/index.ts"
```

Only load extension code and role files that you trust. Workflow scripts run in a separate sandbox; extension factories, registered functions, hooks, and transports run in the trusted host.

## Configuration files

`PI_CODING_AGENT_DIR` changes the Pi agent directory. Otherwise use `~/.pi/agent`.

- Global settings: `<agentDir>/pi-extensible-workflows/settings.json`
- Trusted project settings: `<cwd>/.pi/pi-extensible-workflows/settings.json`
- Global roles: `<agentDir>/pi-extensible-workflows/roles/<name>.md`
- Trusted project roles: `<cwd>/.pi/pi-extensible-workflows/roles/<name>.md`

Missing settings files use defaults. Settings JSON is strict: unknown keys, invalid JSON, and invalid values fail launch or resume. Project settings are ignored when the project is not trusted.

Effective precedence is:

1. Built-in defaults (`concurrency` defaults to `8`; `backgroundWidget` defaults to `true`).
2. Global settings.
3. Trusted project settings, appended after global selectors.
4. Role frontmatter.
5. Per-agent call options.

Selectors are concatenated in that order. A later matching rule wins over earlier rules. Every candidate starts enabled; a matching positive pattern enables it and `!pattern` disables it. `!*` clears the current selection before narrower positive patterns are applied. Candidates with no matching rule remain enabled, and selectors cannot create unavailable resources. Trusted project settings are ignored when the project is untrusted.

Supported settings shape:

```json
{
  "concurrency": 8,
  "backgroundWidget": true,
  "modelAliases": {
    "reviewer-model": "anthropic/claude-fable-5:high"
  },
  "skills": ["*", "!experimental-*"],
  "extensions": ["**/*", "!**/unsafe.mjs"],
  "extensionSettings": { "herdr": { "enableFullyInspectableMode": true } },
  "tools": ["*", "!write"]
}
```
The supported resource fields are direct `skills`, `extensions`, and `tools` arrays. `skills` matches discovered skill names, `extensions` matches discovered normalized extension paths, and `tools` matches only the current root or parent tool boundary. Selectors never create unavailable resources. The legacy `disabledAgentResources` field is rejected; it is not an alias for these fields. Use `extensionSettings.herdr` when extension selectors and Herdr configuration are needed together.

### Concurrency

`concurrency` is an integer from `1` through `16`. The default is `8`.

### Background workflow widget

`backgroundWidget` is a global boolean that defaults to `true`. Set it to `false` to disable the live background-run tree and durable background-run transcript receipts. Foreground workflow rendering is unchanged. Headless and non-TUI hosts do not draw the widget or append receipts.

### Models and aliases

A model reference is static when it is a literal concrete `provider/model[:thinking]` value or a literal alias. Static references are resolved and checked during launch preflight. A role's `model` frontmatter value follows the same rules.

`modelAliases` is a case-sensitive object. Names must match `[A-Za-z][A-Za-z0-9_-]*`. Values are concrete `provider/model` references or another alias, optionally with a thinking suffix such as `:high`. Unknown targets and cycles fail before execution. An alias-specific suffix overrides the target suffix; an explicit call-level thinking option has higher precedence.

Static settings aliases override dynamic aliases with the same name. Use settings for fixed policy and an extension `modelAliases` entry when the target must be resolved from the live model inventory.

#### Dynamic model selection

A model is dynamic when its value cannot be determined during preflight, for example when an agent option is computed from runtime data, `args`, a spread, or another non-literal expression. The workflow is still launchable; the model is resolved when that agent starts against the run's captured model and alias inventory. The resolved model must be available or the agent fails with `UNKNOWN_MODEL`. Dynamic model values are not a new model-registration mechanism; use a static alias or an extension resolver when the policy itself must be named and reusable.

Dynamic model aliases are resolved once per launch or resume, then captured for that execution segment. They are not re-resolved on every agent turn. A role can use a static alias or a dynamic alias in its `model` field.

### Resource selectors

The direct `skills`, `extensions`, and `tools` fields use ordered Minimatch selectors. Rules are applied global settings, trusted project settings, role frontmatter, then agent-call options. Every discovered candidate starts enabled; a matching positive pattern enables it, `!pattern` disables it, and the last matching rule wins. `!*` clears the current selection before narrower positive patterns are applied. An empty selector array is a no-op; prepend `!*` to a positive list when it must restrict the candidate set, or use `!*` alone to select none. Selectors never create unavailable resources or bypass trust filtering. Child capability calls may re-enable discovered skills and extensions through their final overlay, while child tools remain within the parent boundary.

## Standalone Subagents

Use `@piewf/subagents` for one independently launched agent session per task. Single-shot means one agent run rather than a workflow graph; the agent may use tools, take multiple turns, and accept steering.

The model-facing surface is exactly:

| Tool | Contract |
| --- | --- |
| `subagents_run` | Start one run. `prompt` is required; `mode` defaults to `background` and may be `foreground`. |
| `subagents_inspect` | Omit `id` for summaries or provide it for detailed progress and terminal output. |
| `subagents_steer` | Send one message to a running ID. |
| `subagents_stop` | Stop one run and clean its worktree. |
| `subagents_retry` | Start a fresh run from a failed or stopped request, with a new ID and the original mode. |

`subagents_run` accepts the same `label`, `model`, `thinking`, `skills`, `extensions`, `tools`, `role`, `worktree`, `outputSchema`, `retries`, and `timeoutMs` options as workflow agents. A named role or role override may combine with top-level capability selectors, which are the final overlay; `model` and `thinking` remain role-only when a role is selected.

Background calls return an ID immediately. Foreground calls return a terminal envelope and do not produce a background completion follow-up. Do not poll a running ID; call `subagents_inspect({ id })` only when current state or output is needed. Cross-session retry starts fresh and does not restore the old native conversation.

The optional `singleAgent` registered function is workflow composition, not the standalone lifecycle: it returns a bare value and has no `mode`, standalone ID, follow-up, or restoration point. See the [Subagents guide](subagents.html) for the full contract.

## Herdr integration

`@piewf/herdr` requires the core workflow extension and a Herdr-managed pane. It registers workflow attempt actions and a transport setup hook, not model-facing tools.

- The live action hands a transferable running session to Herdr and later returns ownership to the local SDK.
- The completed action opens a persisted completed, failed, or cancelled attempt for inspection.
- `extensionSettings.herdr.enableFullyInspectableMode: true` launches every workflow agent in a dedicated Herdr workspace and hides manual live handoff.
- `PI_CODING_AGENT_DIR` controls where Herdr reads workflow settings.

See the [Herdr guide](herdr.html) for handoff ownership, interruption behavior, and limitations.

## Create an extension

Use TypeScript or JavaScript as a normal Pi extension. The package import is `pi-extensible-workflows`.

Rules:

- Export a default factory.
- Call `registerWorkflowExtension()` inside the factory, not at module top level.
- Provide a strict semantic `version` and non-empty `headline`.
- Register at least one capability: `functions`, `modelAliases`, `agentSetupHooks`, `agentAttemptActions`, or `roleDirectories`. Function descriptions remain on each registered function and power catalog discovery and CLI help.
- Treat all extension code as trusted host code.
- Use globally unique, stable names. Registration is frozen after `session_start`; late registration fails with `REGISTRY_FROZEN`.
- Do not use the removed `workflows` or `variables` registration formats.

Minimal extension with a reusable function:

```ts
import { Type } from "typebox";
import { defineWorkflowFunction, registerWorkflowExtension } from "pi-extensible-workflows";

const greet = defineWorkflowFunction({
  description: "Return a greeting for one person.",
  run(input) {
    return `Hello, ${input.name}!`;
  }
  input: Type.Object(
    { name: Type.String() },
    { additionalProperties: false }
  ),
  output: Type.String(),
});

export default function extension() {
  registerWorkflowExtension({
    version: "1.0.0",
    headline: "Greeting helpers",
    functions: { greet }
  });
}
```

### Extension registration fields

| Field | Required contract |
| --- | --- |
| `version` | Semantic version string such as `1.0.0`. |
| `headline` | Non-empty short label. |
| `functions` | Named host functions with JSON schemas and `run(input, context)`. |
| `modelAliases` | Named dynamic resolvers with `resolve(context)`. |
| `agentSetupHooks` | Named trusted setup hooks with optional finite `priority`. |
| `agentAttemptActions` | Named `/workflow` actions, optionally shared with `/subagents` through paired `visibleStandalone(context)` and `runStandalone(context)`, alongside `label`, synchronous `visible(context)`, and `run(context)`. |
| `roleDirectories` | Absolute filesystem paths or `file:` URLs containing packaged `<name>.md` roles. |

Unknown top-level extension keys are rejected. Function names must be identifier-shaped, globally unique, and must not be reserved globals such as `agent`, `args`, `JSON`, `extensions`, or `workflow_catalog`. Model alias names must match `[A-Za-z][A-Za-z0-9_-]*`. Hook and action names must be identifier-shaped and globally unique.

### Registered functions

A function has exactly `description`, `input`, `output`, and `run`. Schemas must be JSON-compatible; the input schema must describe one object. Inputs and outputs are validated and cloned at the runtime boundary. `run` may return a JSON value or a promise.

For TypeScript extensions, prefer TypeBox schemas with `defineWorkflowFunction()`, as in the example above. The helper infers the read-only `run` input type from `input` and checks its synchronous or asynchronous return type against `output`. Hand-written JSON Schema remains supported but does not provide this inference.

The `run` callback also receives a read-only host context for functions that explicitly need orchestration. Keep workflow composition and workflow-specific rules in the bundled skill rather than copying them into an extension guide.

Completed function calls are journaled and can replay without running the implementation again. Design external effects to be idempotent or bounded. A host crash after an external effect and before journaling can repeat that effect.

### Dynamic model aliases

Register a resolver like this:

```ts
modelAliases: {
  reviewer: {
    resolve({ availableModels, rootModel }) {
      const preferred = "anthropic/opus";
      if (availableModels.has(preferred)) return `${preferred}:high`;
      return `${rootModel.provider}/${rootModel.model}`;
    }
  }
}
```

The resolver context has `cwd`, `projectTrusted`, `rootModel`, `knownModels`, `availableModels`, and an `AbortSignal`. Resolve once per launch or resume. Return a non-empty normal model reference or another alias. Invalid results, cycles, unavailable targets, thrown errors, and cancellation fail the launch with a diagnostic naming the alias and extension.

### Agent setup hooks

Hooks run after normal model, tool, cwd, and role resolution but before the agent session is created. They run in ascending `priority` order; equal priorities use the hook name. The default priority is `10`.

Use a custom JSON-compatible agent option as an explicit opt-in instead of changing every agent:

```ts
agentSetupHooks: {
  advisor: {
    setup(agent, context) {
      if (context.signal.aborted || agent.options.advisor !== true) return;
      const note = "\n\nAdvisor: call out one concrete risk and one next check.";
      agent.sessionInput.systemPromptAppend =
        (agent.sessionInput.systemPromptAppend ?? "") + note;
    }
  }
}
```

Hooks may mutate the prompt, options, session input, or transport, but the immutable prepared launch remains the capability ceiling. Keep hooks short and cancellation-aware. Hook failures prevent session creation and are not native-session retries. Each agent retry starts from a fresh setup baseline and runs hooks again.

### Packaged roles

Use `roleDirectories` for extension-provided role defaults. Paths must be absolute or `file:` URLs; use `new URL("./roles/", import.meta.url)` so copied or installed extensions resolve correctly.

```ts
roleDirectories: [new URL("./roles/", import.meta.url)]
```

Extension roles are defaults. Matching global and trusted project roles override them. Duplicate role names across extension directories are rejected.

## Create and modify roles

A role is a Markdown file named `<role>.md` with optional YAML frontmatter and a prompt body:

```md
---
description: Reviews code for correctness
model: reviewer-model
thinking: high
tools: ["!*", read, grep]
skills: ["review-*", "!experimental-*"]
extensions: ["**/*", "!**/unsafe.mjs"]
contextFiles: [global, project]
---

Focus on correctness, regressions, and concrete next checks.
```
Supported core frontmatter fields include direct `tools`, `skills`, and `extensions` selector arrays. Each uses ordered Minimatch rules; positive rules enable, negated rules disable, and the last match wins.

`description`, `model`, `thinking`, `overrideSystemPrompt`, and `contextFiles` retain their existing meanings. The selector fields are composed after global and trusted project settings and before per-call selectors.

The role body is prompt guidance. Role files are trusted configuration and can change model, tools, context, resources, and system-prompt behavior.

Role selection can be a string or an object:

```js
{ role: "reviewer" }
{ role: { name: "reviewer", model: "cheap-model", thinking: null, tools: ["!*"] } }
```

For a role object, omit a field to inherit it, use `null` to unset it, or provide an explicit replacement. Resource selectors in the top-level agent call are final overlays, including when a named role is selected; model and thinking remain role-only.

### Static and dynamic role references

A role reference is static when the runtime can see a literal role name or a literal role object with a string `name`. It is dynamic when the role depends on runtime data, such as `args`, a computed property, a spread, or another non-literal expression. Dynamic role references are supported, but preflight cannot validate only one role, so launch validation checks every loaded role policy. At execution, the selected role must still exist.

Dynamic roles do not create inline role definitions. The selected role name must resolve to a discovered role file, and its prompt body always comes from that file. The same precedence applies: packaged extension roles are defaults, global roles override them, and trusted project roles override both.

Use a dynamic role when the choice must be made at runtime. Use a static role when possible because it gives earlier unknown-role, model, and tool errors and produces a smaller launch snapshot.

`piewf doctor --role <name>` is the read-only way to inspect the effective role, model, tools, resources, setup hooks, and prepared system prompt. Add `--prompt <text>` when a prompt-dependent hook must be inspected, or `--json` for a machine-readable `DoctorReport` that includes role inspection data.


## Verification checklist

When creating or changing an extension or role:

1. Start from the copyable extension template.
2. Keep registration inside the default extension factory.
3. Use strict JSON schemas and JSON-compatible values.
4. Check names for global collisions and reserved names.
5. Keep trusted hooks opt-in, short, and cancellation-aware.
6. Test registration, role discovery, schema validation, replay-sensitive behavior, and invalid configuration.
7. Run `npm run check` from the repository root.

The workflow DSL, workflow invocation examples, checkpoint handling, budgets, worktrees, and recovery are intentionally outside this file. Read the bundled workflow skill for those tasks.
