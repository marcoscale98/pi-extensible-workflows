import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { normalizeSubagentRunRequest, type SubagentManager, type SubagentManagerContext, type SubagentRunRequest, type SubagentStatus } from "./contracts.js";

const MAX_DETAIL_TEXT = 4000;
const MAX_DETAIL_TOOL_CALLS = 32;

type NavigatorEntry = {
  readonly status: SubagentStatus;
  readonly request?: SubagentRunRequest;
  readonly requestError?: string;
};
type Inspection = { readonly entry: NavigatorEntry; readonly record: Record<string, unknown> };
type NavigatorTheme = Pick<Theme, "fg" | "bold">;

type RegisterCommand = ExtensionAPI["registerCommand"];

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function objectValue(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function isFileNotFound(error: unknown): boolean { return objectValue(error)?.code === "ENOENT"; }
function safeRunId(id: string): boolean { return id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id); }

function statusValue(value: unknown): SubagentStatus | undefined {
  const record = objectValue(value);
  const id = record?.id;
  const state = record?.state;
  if (!record || typeof id !== "string" || !id || state !== "running" && state !== "completed" && state !== "failed" && state !== "stopped") return undefined;
  return value as SubagentStatus;
}

function inspectionValue(value: unknown): { status: SubagentStatus; record: Record<string, unknown> } | undefined {
  const record = objectValue(value);
  const status = statusValue(value);
  return record && status ? { status, record } : undefined;
}

function managerContext(context: ExtensionCommandContext): SubagentManagerContext {
  return { toolCallId: "subagents-command", signal: undefined, onUpdate: undefined, extensionContext: context };
}

async function loadRequest(storageDirectory: string, id: string): Promise<{ request?: SubagentRunRequest; error?: string }> {
  if (!safeRunId(id)) return {};
  try {
    const value: unknown = JSON.parse(await readFile(join(storageDirectory, id, "request.json"), "utf8"));
    return { request: normalizeSubagentRunRequest(value) };
  } catch (error) {
    if (isFileNotFound(error)) return {};
    return { error: errorMessage(error) };
  }
}

async function loadEntries(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext): Promise<NavigatorEntry[]> {
  const value = await manager.inspect({}, managerContext(context));
  if (!Array.isArray(value)) return [];
  const entries: NavigatorEntry[] = [];
  for (const candidate of value) {
    const status = statusValue(candidate);
    if (!status) continue;
    const request = await loadRequest(storageDirectory, status.id);
    entries.push({ status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) });
  }
  return entries;
}

async function inspectEntry(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext): Promise<Inspection> {
  const inspected = inspectionValue(await manager.inspect({ id: entry.status.id }, managerContext(context)));
  if (!inspected) throw new Error(`Subagent ${entry.status.id} returned an invalid inspection`);
  const request = await loadRequest(storageDirectory, entry.status.id);
  return {
    record: inspected.record,
    entry: { status: inspected.status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) },
  };
}

function requestLabel(request: SubagentRunRequest | undefined): string { return request?.label?.trim() || "none"; }
function requestRole(request: SubagentRunRequest | undefined): string {
  const role: unknown = request?.role;
  if (typeof role === "string" && role.trim()) return role.trim();
  const override = objectValue(role);
  return typeof override?.name === "string" && override.name.trim() ? override.name.trim() : "none";
}
function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) : id; }
function pickerLabel(entry: NavigatorEntry, index: number): string { return `${String(index + 1)}. label=${requestLabel(entry.request)} role=${requestRole(entry.request)} [${entry.status.state}] ${shortId(entry.status.id)}`; }
function stateColor(state: SubagentStatus["state"]): "accent" | "success" | "error" { return state === "running" ? "accent" : state === "completed" ? "success" : "error"; }
function boundedText(value: unknown, limit = MAX_DETAIL_TEXT): string {
  const text = typeof value === "string" ? value : (() => { try { const serialized: unknown = JSON.stringify(value); return typeof serialized === "string" ? serialized : String(value); } catch { return String(value); } })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function timestamp(value: unknown): string | undefined { return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined; }
function numberValue(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? String(value) : "?"; }

function appendValue(lines: string[], title: string, value: unknown): void {
  lines.push(`${title}:`);
  for (const line of boundedText(value).split("\n")) lines.push(`  ${line}`);
}

function detailLines(inspection: Inspection, theme?: NavigatorTheme): string[] {
  const { entry, record } = inspection;
  const { status, request } = entry;
  const color = stateColor(status.state);
  const colorize = (value: string): string => theme?.fg(color, value) ?? value;
  const lines = [
    theme?.bold(theme.fg("accent", `Subagent ${status.id}`)) ?? `Subagent ${status.id}`,
    `state=${colorize(status.state)}`,
    `label=${requestLabel(request)}`,
    `role=${requestRole(request)}`,
  ];
  const startedAt = timestamp(status.startedAt);
  const finishedAt = timestamp(status.finishedAt);
  const lastEventAt = timestamp(status.lastEventAt);
  if (startedAt) lines.push(`startedAt=${startedAt}`);
  if (finishedAt) lines.push(`finishedAt=${finishedAt}`);
  if (lastEventAt) lines.push(`lastEventAt=${lastEventAt}`);
  if (request?.prompt) appendValue(lines, "prompt", request.prompt);
  if (entry.requestError) lines.push(`request=unavailable: ${boundedText(entry.requestError)}`);
  const activity = objectValue(status.activity);
  if (activity) lines.push(`activity=${typeof activity.kind === "string" ? activity.kind : "unknown"}${typeof activity.text === "string" && activity.text ? ` ${boundedText(activity.text, 1000)}` : ""}`);
  const progress = objectValue(status.progress);
  const progressState = objectValue(progress?.state);
  const model = progressState?.model;
  const modelRecord = objectValue(model);
  if (modelRecord && typeof modelRecord.provider === "string" && typeof modelRecord.model === "string") lines.push(`model=${modelRecord.provider}/${modelRecord.model}${typeof modelRecord.thinking === "string" ? `:${modelRecord.thinking}` : ""}`);
  const accounting = objectValue(status.accounting);
  if (accounting) lines.push(`accounting=input=${numberValue(accounting.input)} output=${numberValue(accounting.output)} cacheRead=${numberValue(accounting.cacheRead)} cacheWrite=${numberValue(accounting.cacheWrite)} cost=${numberValue(accounting.cost)}`);
  const usage = objectValue(status.usage);
  if (usage) lines.push(`usage=tokens=${numberValue(objectValue(usage.tokens)?.total)} cost=${numberValue(usage.cost)}`);
  const worktree = objectValue(status.worktree);
  if (worktree && typeof worktree.path === "string" && typeof worktree.branch === "string") lines.push(`worktree=${worktree.path} branch=${worktree.branch}`);
  if (Array.isArray(status.toolCalls) && status.toolCalls.length) {
    lines.push(`toolCalls=${String(status.toolCalls.length)}`);
    for (const call of status.toolCalls.slice(-MAX_DETAIL_TOOL_CALLS)) {
      const callValue = objectValue(call);
      if (callValue) lines.push(`  ${typeof callValue.name === "string" ? callValue.name : "unknown"} [${typeof callValue.state === "string" ? callValue.state : "unknown"}]`);
    }
  }
  const failure = objectValue(status.error);
  if (failure && typeof failure.code === "string") appendValue(lines, `error=${failure.code}`, failure.message);

  if (Object.prototype.hasOwnProperty.call(record, "value")) appendValue(lines, "value", record.value);
  return lines;
}

function tuiRows(tui: { terminal?: { rows?: number } }): number { return typeof tui.terminal?.rows === "number" && Number.isFinite(tui.terminal.rows) ? tui.terminal.rows : 24; }

async function showDetail(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext): Promise<void> {
  const inspection = await inspectEntry(manager, storageDirectory, entry, context);
  if (context.mode !== "tui") {
    await context.ui.select(detailLines(inspection).join("\n"), ["Back"]);
    return;
  }
  await context.ui.custom((tui, theme, keybindings, done) => {
    let offset = 0;
    const renderLines = (width: number): string[] => {
      const lines = detailLines(inspection, theme).map((line) => truncateToWidth(line, Math.max(1, width), "…"));
      const viewport = Math.max(1, tuiRows(tui) - 1);
      const maxOffset = Math.max(0, lines.length - viewport);
      offset = Math.min(offset, maxOffset);
      const hint = theme.fg("dim", "↑/↓ scroll · enter/esc back");
      return [...lines.slice(offset, offset + viewport), hint];
    };
    return {
      render: renderLines,
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) { done(undefined); return; }
        const viewport = Math.max(1, tuiRows(tui) - 1);
        if (keybindings.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
        else if (keybindings.matches(data, "tui.select.down")) offset += 1;
        else if (keybindings.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - viewport);
        else if (keybindings.matches(data, "tui.select.pageDown")) offset += viewport;
        else return;
        tui.requestRender();
      },
    };
  });
}

async function runNavigator(manager: SubagentManager, storageDirectory: string, args: string, context: ExtensionCommandContext): Promise<void> {
  if (args.trim()) {
    context.ui.notify("Subagent slash commands do not accept arguments. Open the picker with /subagents; inspection is read-only.", "warning");
    return;
  }
  for (;;) {
    const entries = await loadEntries(manager, storageDirectory, context);
    if (!entries.length) {
      context.ui.notify("No durable subagent runs.", "info");
      return;
    }
    if (!context.hasUI) {
      context.ui.notify(entries.map((entry, index) => pickerLabel(entry, index)).join("\n"), "info");
      return;
    }
    const labels = entries.map(pickerLabel);
    const choice = await context.ui.select("Subagents\n", [...labels, "Close"]);
    if (!choice || choice === "Close") return;
    const selected = entries[labels.indexOf(choice)];
    if (!selected) return;
    try {
      await showDetail(manager, storageDirectory, selected, context);
    } catch (error) {
      context.ui.notify(`Cannot inspect subagent ${selected.status.id}: ${errorMessage(error)}`, "warning");
    }
  }
}

export function registerSubagentNavigator(registerCommand: RegisterCommand, manager: SubagentManager, storageDirectory: string): void {
  registerCommand("subagents", {
    description: "Open the durable subagent picker and inspect run status",
    handler: async (args, context) => {
      try {
        await runNavigator(manager, storageDirectory, args, context);
      } catch (error) {
        context.ui.notify(`Cannot inspect subagents: ${errorMessage(error)}`, "warning");
      }
    },
  });
}
