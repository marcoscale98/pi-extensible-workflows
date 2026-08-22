# pi-extensible-workflows

Deterministic, resumable multi-agent workflow orchestration for Pi.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Subagents](https://vekexasia.github.io/pi-extensible-workflows/subagents.html) | [Herdr](https://vekexasia.github.io/pi-extensible-workflows/herdr.html) | [Roles](https://vekexasia.github.io/pi-extensible-workflows/roles.html) | [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html)

Requires Node.js 22.19 or newer. This is trusted Pi host code with the same filesystem and process access as Pi. Install only code you trust.

## See it

<table>
<tr>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/e886c4c5-bede-4960-a57f-c52bac42f198" width="100%" controls></video>
<br><b>TUI</b><br>Live tree, cost, and the workflow script while a run is in progress.
</td>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/2f3a3865-dacc-426c-89e5-8d0c9e782a0b" width="100%" controls></video>
<br><b>Herdr</b><br>Inspect a live workflow agent in its own pane.
</td>
</tr>
<tr>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/9456f561-b43c-4360-8693-a20466ae2037" width="100%" controls></video>
<br><b>Trajectory</b><br>Gantt of model and tool events, plus steer/stop on a running subagent.
</td>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/953410d9-07a0-45c8-b9ca-42a5f85ca744" width="100%" controls></video>
<br><b>Configuring</b><br>Model aliases, skills, and extension settings.
</td>
</tr>
<tr>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/1c65a1fe-b789-4727-a5c8-961f8fbcf4f1" width="100%" controls></video>
<br><b>Roles</b><br>Markdown roles for tools, model, and policy.
</td>
<td align="center" valign="top" width="50%">
<video src="https://github.com/user-attachments/assets/523bd9e8-18c4-443c-9137-986f7980b452" width="100%" controls></video>
<br><b>Reusable workflows</b><br>Register a callable <code>defineWorkflowFunction</code> and mix shell gates with agents.
</td>
</tr>
</table>

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

The single core installation provides workflows, the `reviewLoop` starter for developer-and-reviewer implementation cycles, and durable standalone subagent tools (`subagents_run`, `subagents_inspect`, `subagents_steer`, `subagents_stop`, and `subagents_retry`). Roles and aliases are overridable; `reviewLoop` is not. See the [starter defaults](https://vekexasia.github.io/pi-extensible-workflows/extensions.html#starter).

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
