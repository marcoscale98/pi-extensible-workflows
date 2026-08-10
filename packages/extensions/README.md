# Companion extensions

These optional packages extend `pi-extensible-workflows`. Install the core package first with `pi install npm:pi-extensible-workflows`, then whichever integration you need:

| Package | Install | What it adds |
| --- | --- | --- |
| [`@piewf/subagents`](./subagents/README.md) | `pi install npm:@piewf/subagents` | Five durable subagent tools with background and foreground modes, inspection, steering, stopping, retries, worktrees, and the optional `singleAgent` workflow function. |
| [`@piewf/herdr`](./herdr/README.md) | `pi install npm:@piewf/herdr` | `/workflow` actions for opening live and completed agent sessions in Herdr panes, plus an optional fully inspectable mode. |

Each package has its own Pi manifest, compiled `dist/index.js` entry point, tests, and public README. The packages share the repository version and are published by `.github/workflows/publish.yml`; see [`RELEASING.md`](../../RELEASING.md) for local package and release checks. The [`workflow-extension-template`](../core/examples/workflow-extension-template/README.md) remains the general extension authoring reference.
