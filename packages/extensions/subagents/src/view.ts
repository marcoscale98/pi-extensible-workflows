import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentRunRequest, SubagentStatus } from "./contracts.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TERMINAL_STATES = new Set<SubagentStatus["state"]>(["completed", "failed", "stopped"]);
type SubagentRenderArgs = Partial<SubagentRunRequest> & { id?: string };

type ProgressComponent = ReturnType<typeof subagentProgressBlock>;
export type SubagentRenderState = {
  subagentSpinner?: ReturnType<typeof setInterval>;
  subagentStatus?: SubagentStatus;
  subagentProgressComponent?: ProgressComponent;
  subagentProgressFrozenAt?: number;
};

function textBlock(text: string) {
  return {
    render(width: number): string[] { return text.split("\n").map((line) => truncateToWidth(line, Math.max(1, width), "…")); },
    invalidate() {},
  };
}

function label(args: SubagentRenderArgs): string {
  if (typeof args.label === "string" && args.label.trim()) return args.label.trim();
  const role: unknown = args.role;
  if (typeof role === "string" && role.trim()) return role.trim();
  if (role && typeof role === "object" && "name" in role && typeof role.name === "string" && role.name.trim()) return role.name.trim();
  if (typeof args.id === "string" && args.id) return args.id.slice(0, 8);
  return "subagent";
}

export function formatSubagentPreview(args: Partial<SubagentRunRequest>): string {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  return [`subagent ${label(args)}`, prompt].filter(Boolean).join("\n");
}

export function renderSubagentCall(args: Partial<SubagentRunRequest>) { return textBlock(formatSubagentPreview(args)); }

function statusValue(value: unknown): SubagentStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || (record.state !== "running" && record.state !== "completed" && record.state !== "failed" && record.state !== "stopped")) return undefined;
  return value as SubagentStatus;
}

function runtime(startedAt: number | undefined, finishedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return "";
  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${remainingSeconds ? ` ${String(remainingSeconds)}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h${remainingMinutes ? ` ${String(remainingMinutes)}m` : ""}`;
}

function stateGlyph(state: SubagentStatus["state"], spinner: string): string {
  if (state === "running") return spinner;
  return state === "completed" ? "✓" : "✗";
}

function stateColor(state: SubagentStatus["state"]): "accent" | "success" | "error" {
  if (state === "running") return "accent";
  return state === "completed" ? "success" : "error";
}

function activity(status: SubagentStatus): string | undefined {
  if (status.state !== "running") return undefined;
  if (status.activity?.kind === "reasoning") return "reasoning";
  if (status.activity?.kind === "text") return "responding";
  if (status.activity?.kind === "tool") return status.activity.text;
  return [...(status.toolCalls ?? [])].reverse().find(({ state }) => state === "running")?.name;
}

function accounting(status: SubagentStatus): string | undefined {
  const value = status.accounting;
  if (!value) return undefined;
  const total = value.input + value.output + value.cacheRead + value.cacheWrite;
  return `tokens=${String(total)} cost=$${value.cost.toFixed(2)}`;
}

function formatSubagentProgress(status: SubagentStatus, args: Partial<SubagentRunRequest>, theme: Theme, spinner: string, now: number, expanded: boolean): string {
  const color = stateColor(status.state);
  const elapsed = runtime(status.startedAt, status.finishedAt, now);
  const lines = [
    `${theme.fg(color, stateGlyph(status.state, spinner))} ${theme.bold(theme.fg("accent", `Subagent: ${label({ ...args, id: status.id })}`))} ${theme.fg(color, `[${status.state}]`)}${elapsed ? ` runtime=${elapsed}` : ""}`,
  ];
  const current = activity(status);
  if (current) lines.push(`  ${theme.fg("accent", spinner)} ${theme.fg("dim", current)}`);
  if (status.error) lines.push(`  ${theme.fg("error", `${status.error.code}: ${status.error.message}`)}`);
  if (expanded) {
    lines.push(`  ${theme.fg("dim", `id=${status.id}`)}`);
    const model = status.progress?.state?.model;
    if (model) lines.push(`  ${theme.fg("dim", `model=${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}`)}`);
    const usage = accounting(status);
    if (usage) lines.push(`  ${theme.fg("dim", usage)}`);
    if (status.worktree) lines.push(`  ${theme.fg("dim", `worktree=${status.worktree.path} branch=${status.worktree.branch}`)}`);
  }
  return lines.join("\n");
}

export function subagentProgressBlock(status: SubagentStatus, args: Partial<SubagentRunRequest>, theme: Theme, freezeAt?: number) {
  let current = status;
  let currentTheme = theme;
  let expanded = false;
  let frozenAt = freezeAt ?? Date.now();
  return {
    id: status.id,
    update(next: SubagentStatus, nextTheme: Theme, nextFreezeAt?: number) {
      current = next;
      currentTheme = nextTheme;
      if (nextFreezeAt !== undefined) frozenAt = nextFreezeAt;
    },
    setExpanded(value: boolean) { expanded = value; },
    render(width: number): string[] {
      const now = TERMINAL_STATES.has(current.state) ? frozenAt : Date.now();
      if (!TERMINAL_STATES.has(current.state)) frozenAt = now;
      const frame = SPINNER[Math.floor(now / 80) % SPINNER.length] ?? "◇";
      return formatSubagentProgress(current, args, currentTheme, frame, now, expanded).split("\n").map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    },
    invalidate() {},
  };
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.filter(({ type }) => type === "text").map((content) => content.type === "text" ? content.text : "").join("\n");
}

export function renderSubagentResult(result: AgentToolResult<unknown>, options: { isPartial: boolean; expanded: boolean }, theme: Theme, context: { args: SubagentRenderArgs; state: SubagentRenderState; invalidate(): void; isError?: boolean }) {
  const incoming = statusValue(result.details);
  const state = context.state;
  if (incoming) state.subagentStatus = state.subagentStatus?.id === incoming.id ? { ...state.subagentStatus, ...incoming } : incoming;
  const status = state.subagentStatus;

  if (status?.state === "running" && options.isPartial && !state.subagentSpinner) {
    state.subagentSpinner = setInterval(() => { context.invalidate(); }, 80);
    state.subagentSpinner.unref();
  } else if ((!options.isPartial || status?.state !== "running") && state.subagentSpinner) {
    clearInterval(state.subagentSpinner);
    delete state.subagentSpinner;
  }

  if (!status || context.isError) return textBlock(resultText(result));
  if (TERMINAL_STATES.has(status.state)) state.subagentProgressFrozenAt ??= Date.now();
  else delete state.subagentProgressFrozenAt;
  let component = state.subagentProgressComponent;
  if (!component || component.id !== status.id) {
    component = subagentProgressBlock(status, context.args, theme, state.subagentProgressFrozenAt);
    state.subagentProgressComponent = component;
  } else {
    component.update(status, theme, state.subagentProgressFrozenAt);
  }
  component.setExpanded(options.expanded);
  return component;
}

type WidgetRun = { status: Readonly<SubagentStatus>; request: Readonly<SubagentRunRequest> };

export function createSubagentBackgroundWidget() {
  const key = "piewf-subagents-background";
  const runs = new Map<string, WidgetRun>();
  let context: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let showing = false;

  const hide = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    requestRender = undefined;
    if (showing) {
      try { context?.ui.setWidget(key, undefined); } catch { /* The session UI may already be closing. */ }
    }
    showing = false;
  };
  const paint = (): void => {
    if (context?.mode !== "tui" || runs.size === 0) {
      hide();
      return;
    }
    if (showing) {
      requestRender?.();
      return;
    }
    try {
      context.ui.setWidget(key, (tui, theme) => {
        requestRender = () => { tui.requestRender(); };
        return {
          render(width: number): string[] {
            const now = Date.now();
            const frame = SPINNER[Math.floor(now / 80) % SPINNER.length] ?? "◇";
            const lines = [theme.bold(theme.fg("accent", `Subagents (${String(runs.size)} running)`))];
            for (const { status, request } of runs.values()) lines.push(formatSubagentProgress(status, request, theme, frame, now, false));
            return lines.flatMap((line) => line.split("\n")).map((line) => truncateToWidth(line, Math.max(1, width), "…"));
          },
          invalidate() {},
        };
      }, { placement: "belowEditor" });
      showing = true;
      timer = setInterval(() => { requestRender?.(); }, 80);
      timer.unref();
    } catch {
      hide();
    }
  };

  return {
    start(next: ExtensionContext): void {
      hide();
      runs.clear();
      context = next.mode === "tui" ? next : undefined;
    },
    update(status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>): void {
      if (request.mode !== "background" || context === undefined) return;
      if (TERMINAL_STATES.has(status.state)) runs.delete(status.id);
      else runs.set(status.id, { status, request });
      paint();
    },
    dispose(): void {
      hide();
      runs.clear();
      context = undefined;
    },
  };
}


export function renderSubagentInspectCall(args: { id?: string }, theme: Theme) {
  const title = theme.fg("toolTitle", theme.bold("subagents_inspect"));
  return textBlock(args.id ? `${title} ${theme.fg("accent", args.id)}` : `${title} ${theme.fg("muted", "all")}`);
}

export function renderSubagentInspectResult(result: AgentToolResult<unknown>, options: { expanded: boolean }, theme: Theme, args: { id?: string }) {
  const status = statusValue(result.details);
  if (status) {
    const component = subagentProgressBlock(status, args.id === undefined ? {} : { label: args.id.slice(0, 8) }, theme, Date.now());
    component.setExpanded(options.expanded);
    return component;
  }
  if (Array.isArray(result.details)) {
    const statuses = result.details.map(statusValue).filter((value): value is SubagentStatus => value !== undefined);
    const lines = [theme.bold(theme.fg("accent", `Subagents (${String(statuses.length)})`)), ...statuses.map((entry) => {
      const color = stateColor(entry.state);
      return `  ${theme.fg(color, stateGlyph(entry.state, "◇"))} ${entry.id.slice(0, 8)} ${theme.fg(color, `[${entry.state}]`)}`;
    })];
    return textBlock(lines.join("\n"));
  }
  return textBlock(resultText(result));
}

export function renderSubagentControlCall(name: string, args: { id: string; message?: string }, theme: Theme) {
  const title = theme.fg("toolTitle", theme.bold(name));
  const message = args.message ? ` ${theme.fg("dim", args.message)}` : "";
  return textBlock(`${title} ${theme.fg("accent", args.id)}${message}`);
}

export function renderSubagentControlResult(result: AgentToolResult<unknown>, theme: Theme) {
  const status = statusValue(result.details);
  if (status) {
    const color = stateColor(status.state);
    return textBlock(`${theme.fg(color, stateGlyph(status.state, "◇"))} ${status.id.slice(0, 8)} ${theme.fg(color, `[${status.state}]`)}`);
  }
  const record = typeof result.details === "object" && result.details !== null && !Array.isArray(result.details) ? result.details as Record<string, unknown> : undefined;
  if (record && typeof record.id === "string") return textBlock(`${theme.fg("success", "✓")} ${record.id.slice(0, 8)}`);
  return textBlock(resultText(result));
}
