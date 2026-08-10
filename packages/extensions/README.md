# Companion extensions

Published packages in this workspace cover two different needs:

| Package | Install | Use | Full documentation |
| --- | --- | --- | --- |
| [`@piewf/subagents`](./subagents/README.md) | `pi install npm:@piewf/subagents` | Standalone single-shot agents with durable lifecycle controls and the same roles and options as workflows. | [Subagents guide](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) |
| [`@piewf/herdr`](./herdr/README.md) | `pi install npm:@piewf/herdr` | Live and completed workflow-agent sessions in Herdr panes. Requires the core workflow extension and a Herdr-managed pane. | [Herdr guide](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) |

Each package has its own Pi manifest, compiled `dist/index.js` entry point, tests, and package reference. The packages share the repository version and are published by `.github/workflows/publish.yml`.

To build a new workflow extension, start with the [`workflow-extension-template`](../core/examples/workflow-extension-template/README.md) and the [extension authoring guide](https://vekexasia.github.io/pi-extensible-workflows/extensions.html). See [`RELEASING.md`](../../RELEASING.md) for package and release checks.
