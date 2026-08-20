# pi-extensible-workflows

Deterministic, resumable multi-agent workflow orchestration for Pi.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Subagents](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) | [Herdr](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) | [Roles](https://vekexasia.github.io/pi-extensible-workflows/roles.html) | [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html)

Requires Node.js 22.19 or newer. This is trusted Pi host code with the same filesystem and process access as Pi. Install only code you trust.

## Install

```sh
pi install npm:pi-extensible-workflows
```

For source installation and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).

## Quick start

Ask Pi to run a workflow. The main agent writes the script for the current task.

```js
const reports = await parallel("review", {
  api: () => agent("Review the API."),
  tests: () => agent("Review the tests."),
});

return agent(prompt("Summarize these reports:\n\n{reports}", { reports }));
```

Runs are backgrounded by default; set `foreground: true` to wait for the final value. Use `pipeline()` for staged work, `withWorktree()` for isolation, and `checkpoint()` for approval.

## Included capabilities

The single core installation provides workflows, the `reviewLoop` starter for developer-and-reviewer implementation cycles, and durable standalone subagent tools (`subagents_run`, `subagents_inspect`, `subagents_steer`, `subagents_stop`, and `subagents_retry`).

### Companion packages

- [`@piewf/herdr`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/extensions/herdr) (`pi install npm:@piewf/herdr`): workflow-agent sessions in Herdr panes.
- [`@piewf/cli`](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/cli) (`pi install npm:@piewf/cli`): the `piewf` command for workflow operations.

## Development

```sh
npm ci
npm run check
```

See [RELEASING.md](RELEASING.md) for the release process.

## License

MIT
