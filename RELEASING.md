# Releasing

This fork publishes three public npm workspaces:

- `@marcoscale98/pi-extensible-workflows` from `packages/core`;
- `@marcoscale98/piewf-cli` from `packages/cli`;
- `@marcoscale98/piewf-herdr` from `packages/extensions/herdr`.

The repository is public. All packages share one version. Fork releases use
the `X.Y.Z-fork.N` version format and the npm `fork` dist-tag. The matching Git
tag is `vX.Y.Z-fork.N`.

Before the first release, run `npm whoami` and confirm that the account can
publish under `@marcoscale98`. Set the `NPM_TOKEN` repository secret for the
bootstrap release. The publish workflow uses it as `NODE_AUTH_TOKEN` and publishes
with provenance. After all three packages exist, configure npm trusted publishing
for this repository and `.github/workflows/publish.yml`, then remove `NPM_TOKEN`.

For local release checks:

```sh
npm ci
npm run check
npm pack --dry-run --json --workspace=packages/core
npm pack --dry-run --json --workspace=packages/cli
npm pack --dry-run --json --workspace=packages/extensions/herdr
npm run test:packages
```

`test:packages` creates and installs all three tarballs in an isolated directory.
It checks package entrypoints, scoped dependencies, the CLI, Pi package discovery,
and the packaged Trajectory server. It does not publish anything.

The core package stages the repository-root `CHANGELOG.md` into the generated,
gitignored `packages/core/CHANGELOG.md` during `prepack`. Its `postpack` hook
removes that copy. Do not use `--ignore-scripts` when packing core. Staging refuses
to overwrite an existing changelog. After an interrupted pack, run:

```sh
node scripts/stage-core-changelog.mjs clean
```

The cleanup command removes the changelog and marker only when
`.tmp/core-changelog-staged` exists.
