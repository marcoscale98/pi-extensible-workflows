# Companion extensions

Published packages in this workspace cover companion extensions for the core workflow package:

| Package | Install | Use | Full documentation |
| --- | --- | --- | --- |
| [`@piewf/herdr`](./herdr/README.md) | `pi install npm:@piewf/herdr` | Live and completed workflow-agent sessions in Herdr panes. Requires the core workflow extension and a Herdr-managed pane. | [Herdr guide](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) |

Standalone subagent tools are included in the core package.
The Herdr package has its own Pi manifest, compiled `dist/index.js` entry point, tests, and package reference. It is published by `.github/workflows/publish.yml`.

To build a new workflow extension, start with the [`workflow-extension-template`](../core/examples/workflow-extension-template/README.md) and the [extension authoring guide](https://vekexasia.github.io/pi-extensible-workflows/extensions.html). See [`RELEASING.md`](../../RELEASING.md) for package and release checks.
