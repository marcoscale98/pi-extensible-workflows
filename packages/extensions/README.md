# Extension workspaces

Published extension packages live here as separate npm workspaces:

- [`@piewf/herdr`](./herdr/README.md) adds Herdr live-session actions and transport integration.
- [`@piewf/subagents`](./subagents/README.md) adds five durable subagent tools with background-by-default and foreground modes, plus the optional `singleAgent` workflow function; a name collision disables only that optional catalog entry.

Each package has its own Pi manifest, compiled `dist/index.js` entry point, tests, and public README. The packages share the repository version and are published by `.github/workflows/publish.yml`; see [`RELEASING.md`](../../RELEASING.md) for local package and release checks. The [`workflow-extension-template`](../core/examples/workflow-extension-template/README.md) remains the general extension authoring reference.
