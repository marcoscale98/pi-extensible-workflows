# 6.0.0 release verification

Release: [v6.0.0](https://github.com/vekexasia/pi-extensible-workflows/releases/tag/v6.0.0).

Core, `@piewf/cli` and `@piewf/herdr` 6.0.0 were published by GitHub Actions using npm Trusted Publishing, with registry provenance verified. The implementation commit is `90c12b1`. The extraction planning document was excluded.

## Isolated live-model installations

Two separate temporary environments used Pi 1.0.4 installed from npm:

- A: `pi install npm:pi-extensible-workflows@6.0.0` only.
- B: the same package plus `pi install npm:@piewf/pi-ext-roles@0.1.2`, in both installation orders.

Each had its own HOME, agent directory, npm prefix/cache and project. No personal settings, extensions, roles or skills were copied. Only access to the real model gateway was supplied through a credential environment variable and a minimal `models.json`. No provider extension or `@piewf/cli` was installed.

Both managed installs resolved roles 0.1.2 automatically, without installing a physical Pi SDK in the managed npm tree or exposing `pi-role` on PATH. Workflows were invoked by the native Pi `workflow` tool, not `piewf run` or a mocked transport.

Fable and Opus could not run the live suite: the provider returned `You're out of extra usage` on the plain Pi control request before workflows loaded. The completed suite used catalog-verified `gpt-5.6-luna` and `gpt-5.6-sol` through the gateway's OpenAI-completions API.

## Completed cases

17 cases passed across A and B. Successful results were verified from persisted run state, child session transcripts and native tool results, not just the parent model's answer.

| Case | A | B | Verified outcome |
| --- | --- | --- | --- |
| Fallback scout | Pass | Pass | Inherits Luna, uses read-only tools, reads the fixture file and submits the exact structured result |
| Role alias and per-call override | Pass | Pass | First child selects Sol through the alias; second selects Luna through the explicit override |
| Explicit project denial | Pass | Pass | Global role/model wins; project-only prompt is absent |
| Explicit project approval | Pass | Pass | Project role/model wins and its prompt is present |
| Unknown alias | Pass | Pass | Explicit error, no child session and no silent model fallback |
| Trusted project alias map `{}` | Pass | Pass | Global alias is unavailable; terminal `UNKNOWN_MODEL`, no child session or child-model tokens |
| Contributor with declared roles dependency | Pass | Pass | Its own installed dependency registers a role consumed by a real workflow child on Sol |
| Contributor through standalone subagent | Pass | Pass | Completed on Sol; persisted setup is read-only and transcript contains an actual `read` result |
| Reversed workflow/roles installation order | N/A | Pass | Reviewer resolves without duplicate-role errors and completes on Luna |

The project-alias `{}` case creates a failed persisted workflow record, unlike the unknown-alias preflight case. It fails before creating a child session or making a child-model request. Record creation alone is not silent fallback.

## Previous regression gates

Before publication, `npm run check`, `npm run test:packages`, and `scripts/verify-role-upgrade.py` passed. The latter used isolated Pi 1.0.2 and a local HTTP provider to verify the real 5.19.1-to-6.0.0 upgrade, unchanged legacy files/settings, new-path precedence, warning/reload, normal Pi and selected-role regular/fullscreen TUI, tool execution/no-tools, binary handover without force, contributor migration and re-exported bundle execution.

## Remaining coverage

Not exercised with hosted models: `/reload` and `/new`, disabling one enabled package, interrupted-run recovery, MCP, Windows PTY, mixed roles versions, direct Anthropic API, or OpenAI Responses transport. TUI/reload coverage above used Pi 1.0.2 and the local provider, not the live-model 1.0.4 environments.

The pre-existing Pi trust behavior remains: custom role directories alone do not trigger its native project-trust gate. Explicit `--no-approve` excludes project roles; the live tests checked explicit deny/approve, not an implicit denial for a role-only project.

Local evidence and the live runner are under `.tmp/roles-release/live/` and `.tmp/roles-release/live-e2e.py`. Temporary installations were removed; secrets were not committed or included in this report.
