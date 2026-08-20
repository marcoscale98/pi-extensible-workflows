# Releasing

This repository uses npm workspaces. `packages/core` is the publishable
`pi-extensible-workflows` package, `packages/cli` is the publishable
`@piewf/cli` package, and `packages/extensions/herdr` is the publishable
`@piewf/herdr` package; the repository root is private and is never published.
Satellite packages use the `@piewf` scope, while the core package keeps its
established unscoped name. Standalone subagent tools are shipped inside core.

Publishable workspaces use one fixed shared version. Keep the root version and
each publishable workspace version equal, then create the matching `vX.Y.Z`
tag. The publish workflow verifies every package version, runs the root checks,
packs every publishable workspace, then publishes core, CLI, and Herdr.

For local release checks:

```sh
npm install
npm run check
npm pack --dry-run --json --workspace=packages/core
npm pack --dry-run --json --workspace=packages/cli
npm pack --dry-run --json --workspace=packages/extensions/herdr
```

The core package stages the repository-root `CHANGELOG.md` into the generated, gitignored `packages/core/CHANGELOG.md` during `prepack`. Its `postpack` hook removes that staging copy after `npm pack` completes. Do not use `--ignore-scripts` when packing core: it skips both hooks and the package-local changelog is not staged. Staging refuses to overwrite an existing `packages/core/CHANGELOG.md`; this protects a stale or user-created file. After an interrupted pack, recover from the repository root with:

```sh
node scripts/stage-core-changelog.mjs clean
```

The cleanup command removes the package-local changelog and marker only when the staging marker `.tmp/core-changelog-staged` exists; otherwise it does nothing. If that marker is missing but `packages/core/CHANGELOG.md` remains, delete that file manually before packing again.
