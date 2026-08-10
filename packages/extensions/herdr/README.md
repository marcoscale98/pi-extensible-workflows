# `@piewf/herdr`

Connect workflow agents to Herdr panes. When Pi runs in a Herdr-managed pane, this extension adds `/workflow` actions for opening a live agent session or revisiting a completed one in Herdr.

## Install

```sh
pi install npm:pi-extensible-workflows
pi install npm:@piewf/herdr
```

If the core package is already installed, only the second command is needed. The integration is active only inside a Herdr-managed pane.

## Fully inspectable mode

Set fully inspectable mode in the global workflow settings file (`~/.pi/agent/pi-extensible-workflows/settings.json`):

```json
{ "extensions": { "herdr": { "enableFullyInspectableMode": true } } }
```

Fully inspectable mode launches each workflow agent in a dedicated labeled Herdr workspace and hides the manual live-session action while the agent is active.

Live handoff pauses the local SDK at a turn boundary. The originating Pi TUI shows the handed-off agent's working state and idle or completed state before handback while the Herdr pane owns the task. Pane exit, `/quit`, or a pane that returns idle after Herdr has observed it working returns ownership to the local SDK. Completed agent sessions can be opened in a separate Herdr pane from the navigator without taking ownership. The monitor relies on Herdr's built-in Pi screen detection and therefore cannot distinguish an aborted turn from a completed one. In Pi's default keybindings, interrupt is `Escape`; use double-`Escape` to abort a turn. A single `Ctrl-C` clears the editor and double-`Ctrl-C` exits Pi, so `Ctrl-C` is not a handback signal. Lifecycle reports from this extension are advisory when Herdr's built-in Pi integration has authority. Inline extension factories are materialized as temporary explicit extensions in the Herdr pane.
