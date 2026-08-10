# Companion extensions

These packages cover two different needs: `@piewf/subagents` works standalone for single-shot agents, while `@piewf/herdr` complements the core workflow extension.

| Package | Install | What it adds |
| --- | --- | --- |
| [`@piewf/subagents`](./subagents/README.md) | `pi install npm:@piewf/subagents` | One independent agent session per task, with background and foreground modes, lifecycle controls, worktrees, and the same roles and agent options as workflows. |
| [`@piewf/herdr`](./herdr/README.md) | `pi install npm:@piewf/herdr` | `/workflow` actions for opening live and completed agent sessions in Herdr panes, plus an optional fully inspectable mode. |

Each package has its own Pi manifest, compiled `dist/index.js` entry point, tests, and public README. The packages share the repository version and are published by `.github/workflows/publish.yml`; see [`RELEASING.md`](../../RELEASING.md) for local package and release checks. The [`workflow-extension-template`](../core/examples/workflow-extension-template/README.md) remains the general extension authoring reference.
