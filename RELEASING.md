# Releasing

This repository uses npm workspaces. `packages/core` is the publishable
`pi-extensible-workflows` package, `packages/cli` is the publishable
`@piewf/cli` package, `packages/extensions/herdr` is the publishable
`@piewf/herdr` package, and `packages/extensions/subagents` is the
publishable `@piewf/subagents` package; the repository root is private and is
never published. Satellite packages use the `@piewf` scope, while the core
package keeps its established unscoped name. `packages/extensions/*` holds
extension packages such as `@piewf/herdr` and `@piewf/subagents`.

Publishable workspaces use one fixed shared version. Keep the root version and
each publishable workspace version equal, then create the matching `vX.Y.Z`
tag. The publish workflow verifies every package version, runs the root checks,
packs every publishable workspace, then publishes core, CLI, Herdr, and
Subagents in that order.

For local release checks:

```sh
npm install
npm run check
npm pack --dry-run --json --ignore-scripts --workspace=packages/core
npm pack --dry-run --json --ignore-scripts --workspace=packages/cli
npm pack --dry-run --json --ignore-scripts --workspace=packages/extensions/herdr
npm pack --dry-run --json --ignore-scripts --workspace=packages/extensions/subagents
```
