import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { copyToClipboard, getAgentDir, ModelSelectorComponent, SettingsManager, type ExtensionAPI, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FairAgentScheduler, getAgentAttempts, WorkflowAgentExecutor, localAgentTransport, type AgentActivity, type AgentAttempt, type AgentDefinition, type AgentProgress, type AgentProviderFailure, type AgentProviderRecovery } from "./agent-execution.js";
import { RunLifecycle, WorkflowEventPublisher, nextNamedOccurrence, withWorkflowFunctions, workflowRunContext, type WorkflowRunRecord, type WorkflowToolUpdate } from "./host-runtime.js";
import { createWorkflowRecovery, persistedFailure } from "./host-recovery.js";
import { registerWorkflowNavigator, uiHostCapabilities } from "./host-navigator.js";
import { acquireSessionLease, isPersistedRun, listPersistedSessionIds, listRunIds, RunStore, SessionLease, structuralPath as operationPath } from "./persistence.js";
import type { PersistedRun, WorktreeReference } from "./persistence.js";
import { validateBudget, WorkflowBudgetRuntime } from "./budget.js";
import { asWorkflowError, createLaunchSnapshot, errorCode, errorText, fail, jsonValue, modelAliasErrorName, modelCapability, object, parseModelReference, parseThinking, positiveInteger, validateModelAliases } from "./utils.js";
import { loadAgentDefinitions, preflight, resolveAgentResourcePolicy, resolveWorkflowSettings, validateCheckpoint, validateModelAliasAvailability, validateWorkflowLaunchWithRegistry, workflowProjectSettingsPath, workflowSettingsPath } from "./validation.js";
import { beginWorkflowExtensionLoading, loadingRegistry, resetWorkflowRegistryIfIdle, retainWorkflowRegistry, type WorkflowRegistryApi } from "./registry.js";
import { agentIdentityPath, agentWorktree, encoded, executeShellCommand, persistActiveAgentAttempt, persistAgentAttempts, readShellResult, runWorkflow, shellIdentityPath } from "./execution.js";
import { LAUNCH_SNAPSHOT_IDENTITY_VERSION, WORKFLOW_BLOCKED_EVENT, WorkflowError, roleNameOf, type AgentRecord, type AgentResourcePolicy, type AgentTransport, type JsonValue, type LaunchSnapshot, type ModelSpec, type RoleOverride, type RunState, type ShellIdentity, type ShellOptions, type ShellResult, type WorkflowErrorCode, type WorkflowFailureDiagnostics, type WorkflowMetadata, type WorkflowModelAliasResolverContext, type WorkflowSettings, type WorkflowSettingsResolution, type WorkflowWorktreeReference } from "./types.js";
import {
  SETTLED_AGENT_STATES,
  catalogResultValue,
  formatWorkflowCatalog,
  styledTextBlock,
  textBlock,
  workflowCatalogBlock,
  workflowControlCall,
  workflowControlResult,
  workflowProgressBlock,
  formatWorkflowProgress,
  type WorkflowProgressRenderState,
} from "./host-view.js";
import {
  DELIVERY_LIMIT_BYTES,
  markWorkflowFailureDiagnostics,
  WORKFLOW_LOG_ENTRY,
  completionDeliveryFromStore,
  createWorkflowFailureDiagnostics,
  failureDiagnosticsFrom,
  formatWorkflowFailure,
  formatWorkflowFailureDelivery,
  formatWorkflowFailureDeliveryFallback,
  formatWorkflowFailureDiagnostics,
  isWorkflowFailureDiagnostics,
  serializeWorkflowFailureDiagnostics,
  utf8Prefix,
  type CompletionDeliveryContext,
  type WorkflowLogEntry,
} from "./host-delivery.js";

export type WorkflowExtensionAPI = Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getThinkingLevel" | "on" | "registerCommand" | "registerTool" | "sendMessage">;

export {
  agentBreadcrumb,
  agentBreadcrumbParts,
  formatBudgetStatus,
  formatNavigatorDashboard,
  formatNavigatorRun,
  formatStalledDuration,
  formatWorkflowPhaseDashboard,
  formatWorkflowProgress,
  navigatorAttentionSort,
  truncateWorkflowProgress,
} from "./host-view.js";
export { buildWorkflowPhaseModel, buildWorkflowPhaseTree, navigateWorkflowPhaseTree, preserveWorkflowPhaseSelection, preserveWorkflowPhaseTreeSelection, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes } from "./host-phases.js";
export type {
  WorkflowPhaseAgentCounts,
  WorkflowPhaseModel,
  WorkflowPhaseSelection,
  WorkflowPhaseState,
  WorkflowPhaseTree,
  WorkflowPhaseTreeDirection,
  WorkflowPhaseTreeNode,
  WorkflowPhaseTreeNodeKind,
  WorkflowPhaseTreeSelection,
  WorkflowPhaseView,
} from "./host-phases.js";
export type { WorkflowProgressStyles } from "./host-view.js";
export { formatWorkflowFailure, formatWorkflowFailureDelivery, formatWorkflowFailureDiagnostics } from "./host-delivery.js";
export { RunLifecycle } from "./host-runtime.js";

const INTERNAL_WORKFLOW_TOOLS: readonly string[] = ["workflow", "workflow_respond", "workflow_stop", "workflow_status", "workflow_resume", "workflow_retry", "workflow_catalog"];
const HARD_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);
const SHUTDOWN_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "budget_exhausted"]);
const FAILURE_DELIVERY_STATES: ReadonlySet<RunState> = new Set(["failed", "stopped", "interrupted", "budget_exhausted"]);
function snapshotResourcePolicy(snapshot: Readonly<LaunchSnapshot>, cwd: string, projectTrusted: boolean, globalSettingsPath: string): AgentResourcePolicy {
  const empty = { skills: [], extensions: [] };
  return { globalSettingsPath, projectSettingsPath: workflowProjectSettingsPath(cwd), projectTrusted, global: empty, project: empty, effective: snapshot.settings.disabledAgentResources ?? empty, unmatchedSkills: [], unmatchedExtensions: [] };
}
type WorkflowLaunchSettings = { settings: Readonly<WorkflowSettings>; resolution: WorkflowSettingsResolution; resourcePolicy: AgentResourcePolicy };
function workflowLaunchSettings(cwd: string, projectTrusted: boolean, globalSettingsPath: string, concurrency?: number): WorkflowLaunchSettings {
  const resolution = resolveWorkflowSettings(cwd, projectTrusted, globalSettingsPath);
  const settings = Object.freeze({ ...resolution.effective, ...(concurrency === undefined ? {} : { concurrency }) });
  return { settings, resolution, resourcePolicy: resolveAgentResourcePolicy(cwd, projectTrusted, globalSettingsPath) };
}
function frozenResourcePolicy(policy: AgentResourcePolicy): () => AgentResourcePolicy { return () => structuredClone(policy); }
function resumedSnapshotSettings(snapshot: Readonly<LaunchSnapshot>, resolution: WorkflowSettingsResolution, modelAliases: Readonly<Record<string, string>>): { settings: WorkflowSettings; settingsSources?: NonNullable<LaunchSnapshot["settingsSources"]> } {
  const settings: WorkflowSettings = { ...snapshot.settings, concurrency: snapshot.settingsSources === undefined || snapshot.settingsSources.concurrency === "per-run options" ? snapshot.settings.concurrency : resolution.effective.concurrency, modelAliases };
  if (resolution.effective.disabledAgentResources === undefined) delete settings.disabledAgentResources;
  else settings.disabledAgentResources = resolution.effective.disabledAgentResources;
  const settingsSources = snapshot.settingsSources === undefined ? undefined : { ...snapshot.settingsSources, modelAliases: resolution.sources.modelAliases, disabledAgentResources: resolution.sources.disabledAgentResources, concurrency: snapshot.settingsSources.concurrency === "per-run options" ? "per-run options" : resolution.sources.concurrency };
  return { settings, ...(settingsSources === undefined ? {} : { settingsSources }) };
}
function mainAgentError(error: unknown): WorkflowError {
  const typed = asWorkflowError(error);
  const presented = new WorkflowError(typed.code, formatWorkflowFailure(typed));
  Object.assign(presented, typed);
  return presented;
}
function completionControlContent(result: unknown, controlRunId?: string): string {
  const record = object(result) ? { ...result } : undefined;
  if (record && controlRunId !== undefined && record.runId === undefined) record.runId = controlRunId;
  const completion = record && object(record.completion) ? record.completion : undefined;
  if (!record || !completion || typeof completion.content !== "string") {
    const serialized = JSON.stringify(record ?? result);
    return typeof serialized === "string" ? serialized : String(result);
  }
  let value: unknown;
  try { value = JSON.parse(completion.content) as unknown; }
  catch { value = completion.content; }
  delete record.value;
  delete record.completion;
  delete record.run;
  return JSON.stringify({ ...record, value });
}
export function formatWorkflowPreview(args: { script?: unknown; scriptPath?: unknown; name?: unknown; description?: unknown }): string {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "workflow";
  if (typeof args.script !== "string" || !args.script.trim()) return `workflow ${name}`;
  return [`workflow ${name}`, typeof args.description === "string" && args.description.trim() ? args.description.trim() : ""].filter(Boolean).join("\n");
}
export const WORKFLOW_TOOL_LABEL = "Workflow";
export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow with a named inline or file-backed parallel-to-summary path by default"
export const WORKFLOW_TOOL_PROMPT_SNIPPET = "Run a deterministic, resumable JavaScript workflow. Prefer a named inline script that fans out independent work with parallel(...), awaits the keyed results before interpolating them into one summarizing agent(...), and returns. Provide exactly one of script or scriptPath and a non-empty name. Registered catalog functions are available as globals inside the script; call them there, for example return await someFunction(args). Advanced controls include registered functions, outputSchema, budgets, checkpoints, worktrees, retry/resume, CLI export, and pipelines. Runs are in the background by default; completion arrives as a follow-up message. Set foreground: true when the caller must wait for the final value. Manage runs from the interactive /workflow picker; use workflow_status, workflow_resume, workflow_retry, workflow_stop, and workflow_respond for explicit tool controls. If a foreground call detaches before its result is accepted, its terminal success or failure is promoted to one follow-up message. Foreground results include the completed run ID. Recovery inherits the source launch mode; legacy snapshots without launchMode recover in the background. Set foreground: true or false on workflow_resume/workflow_retry to override it; foreground recovery waits for terminal value and run details, while background recovery returns immediately and delivers completion or failure as a follow-up. After failure follow-ups, especially CANCELLED or interrupted runs, call workflow_status({ runId }) before recovery or replacement work, then pass its state as expectedState to workflow_retry/workflow_resume so recovery cannot act on a state that changed. Recovery map: agent(..., { retries }) reruns one agent call in the same run for transient failures; workflow_retry({ runId, expectedState?, foreground? }) replays a failed run into a child; workflow_resume({ runId, expectedState?, budget?, foreground? }) continues a budget_exhausted run; parentRunId on a new launch only borrows named worktrees and never replays or resumes."
export const WORKFLOW_TOOL_PARAMETERS = Type.Object({
  name: Type.String({ description: "Required non-empty workflow name" }),
  description: Type.Optional(Type.String({ description: "Optional human-readable workflow description" })),
  script: Type.Optional(Type.String({ description: "Immutable inline workflow source; provide exactly one of script or scriptPath" })),
  scriptPath: Type.Optional(Type.String({ description: "Path to a JavaScript workflow file, read once at launch and persisted as the inline source; provide exactly one of script or scriptPath" })),
  args: Type.Optional(Type.Unknown({ description: "JSON-compatible values available inside the workflow script as args" })),
  foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of the default background launch" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Advanced: optional per-run active-agent limit" })),
  budget: Type.Optional(Type.Unknown({ description: "Advanced: optional aggregate soft and hard run budgets" })),
  parentRunId: Type.Optional(Type.String({ description: "Advanced: terminal run whose named worktrees may be reused" })),
}, { additionalProperties: false });
export const WORKFLOW_STATUS_PARAMETERS = Type.Object({ runId: Type.String({ description: "Workflow run ID visible in the current project" }) }, { additionalProperties: false });
export const WORKFLOW_RETRY_PARAMETERS = Type.Object({ runId: Type.String({ description: "Explicit failed workflow run ID" }), expectedState: Type.Optional(Type.String({ description: "Persisted source state observed before recovery" })), foreground: Type.Optional(Type.Boolean({ description: "Override the source launch mode for this recovery" })) });

function workflowToolUpdate(run: PersistedRun): WorkflowToolUpdate {
  return { content: [{ type: "text", text: formatWorkflowProgress(run) }], details: { runId: run.id, run } };
}
function agentWithProgress(agent: AgentRecord, progress: AgentProgress): AgentRecord {
  const next = { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls };
  if (progress.state !== undefined) {
    next.model = progress.state.model;
    next.tools = progress.state.tools;
    if (progress.state.systemPrompt !== undefined) next.systemPrompt = progress.state.systemPrompt;
  }
  if (progress.activity === undefined) delete next.activity;
  else next.activity = progress.activity;
  if (progress.lastEventAt !== undefined) next.lastEventAt = progress.lastEventAt;
  return next;
}

type WorkflowToolResult = { runId?: string; run?: PersistedRun; value?: JsonValue; preview?: string };
function isWorkflowToolResult(value: unknown): value is WorkflowToolResult {
  return object(value) && (value.runId === undefined || typeof value.runId === "string") && (value.run === undefined || isPersistedRun(value.run)) && (value.value === undefined || jsonValue(value.value)) && (value.preview === undefined || typeof value.preview === "string");
}

function deliver(pi: WorkflowExtensionAPI, content: string): void {
  if (typeof pi.sendMessage !== "function") return;
  pi.sendMessage({ customType: "workflow", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}

type WorkflowEventSink = { emit: (name: string, payload: unknown) => unknown };



function projectTrusted(ctx: unknown): boolean {
  const check = object(ctx) ? ctx.isProjectTrusted : undefined;
  return typeof check === "function" ? Boolean(Reflect.apply(check, ctx, [])) : true;
}
function asFn(value: unknown): ((...args: never[]) => unknown) | undefined { return typeof value === "function" ? value as (...args: never[]) => unknown : undefined; }
function completionContext(ctx: unknown): CompletionDeliveryContext {
  const host = object(ctx) ? ctx : undefined;
  if (!host) return {};
  const getContextUsage = asFn(host.getContextUsage);
  const getModel = () => {
    const model = object(ctx) && object(ctx.model) ? ctx.model : undefined;
    const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
    const maxTokens = typeof model?.maxTokens === "number" ? model.maxTokens : undefined;
    return contextWindow === undefined && maxTokens === undefined ? undefined : { ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) };
  };
  return {
    ...(getContextUsage ? { getContextUsage: () => Reflect.apply(getContextUsage, ctx, []) as ReturnType<NonNullable<CompletionDeliveryContext["getContextUsage"]>> } : {}),
    getModel,
  };
}
type PiHostCapabilities = { registerEntryRenderer?: ExtensionAPI["registerEntryRenderer"]; events?: WorkflowEventSink };
function isWorkflowEventSink(value: unknown): value is WorkflowEventSink { return object(value) && typeof value.emit === "function"; }
function piHostCapabilities(pi: unknown): PiHostCapabilities {
  if (!object(pi)) return {};
  const registerEntryRenderer = asFn(pi.registerEntryRenderer) as NonNullable<PiHostCapabilities["registerEntryRenderer"]> | undefined;
  const events = pi.events;
  return { ...(registerEntryRenderer ? { registerEntryRenderer } : {}), ...(isWorkflowEventSink(events) ? { events } : {}) };
}
type ContextHostCapabilities = { modelRegistry?: ModelRegistryCapability };
type ModelRegistryGetter = () => readonly Model<Api>[];
type ModelRegistryCapability = { getAll?: ModelRegistryGetter; getAvailable?: ModelRegistryGetter; find?: (provider: string, model: string) => Model<Api> | undefined; refresh?: () => Promise<void>; getError?: () => string | undefined };
function contextHostCapabilities(ctx: unknown): ContextHostCapabilities {
  if (!object(ctx) || !object(ctx.modelRegistry)) return {};
  const registry = ctx.modelRegistry;
  const getAll = asFn(registry.getAll) as ModelRegistryGetter | undefined;
  const getAvailable = asFn(registry.getAvailable) as ModelRegistryGetter | undefined;
  const find = asFn(registry.find) as ModelRegistryCapability["find"];
  const refresh = asFn(registry.refresh) as ModelRegistryCapability["refresh"];
  const getError = asFn(registry.getError) as ModelRegistryCapability["getError"];
  return { modelRegistry: { ...(getAll ? { getAll: () => getAll.call(registry) } : {}), ...(getAvailable ? { getAvailable: () => getAvailable.call(registry) } : {}), ...(find ? { find: (provider, model) => find.call(registry, provider, model) } : {}), ...(refresh ? { refresh: () => refresh.call(registry) } : {}), ...(getError ? { getError: () => getError.call(registry) } : {}) } };
}
function modelInventory(root: ModelSpec | undefined, registry: ModelRegistryCapability | undefined): { knownModels: ReadonlySet<string>; availableModels: ReadonlySet<string> } {
  const all = registry?.getAll?.() ?? registry?.getAvailable?.() ?? [];
  const available = registry?.getAvailable?.() ?? registry?.getAll?.() ?? [];
  const knownModels = new Set(all.map((model) => `${model.provider}/${model.id}`));
  const availableModels = new Set(available.map((model) => `${model.provider}/${model.id}`));
  const rootName = root?.provider && root.model ? `${root.provider}/${root.model}` : undefined;
  if (rootName) { knownModels.add(rootName); availableModels.add(rootName); }
  return { knownModels, availableModels };
}
function resumeHostContext(ctx: unknown): { model: { provider: string; id: string } | undefined; modelRegistry: ModelRegistryCapability | undefined; deliveryContext: CompletionDeliveryContext } {
  const model = object(ctx) && object(ctx.model) && typeof ctx.model.provider === "string" && typeof ctx.model.id === "string" ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  return { model, modelRegistry: contextHostCapabilities(ctx).modelRegistry, deliveryContext: completionContext(ctx) };
}
async function resolveLaunchAliases(registry: WorkflowRegistryApi, staticAliases: Readonly<Record<string, string>>, context: Readonly<WorkflowModelAliasResolverContext>, availableModels: ReadonlySet<string>, knownModels: ReadonlySet<string>, settingsPath: string): Promise<{ aliases: Readonly<Record<string, string>>; dynamicNames: readonly string[] }> {
  const dynamic = typeof registry.resolveModelAliases === "function" ? await registry.resolveModelAliases(context, new Set(Object.keys(staticAliases))) : {};
  const dynamicNames = Object.keys(dynamic);
  try {
    const aliases = validateModelAliases({ ...dynamic, ...staticAliases }, settingsPath);
    validateModelAliasAvailability(aliases, dynamicNames, availableModels, knownModels, settingsPath);
    return { aliases, dynamicNames };
  } catch (error) {
    const name = modelAliasErrorName(error);
    const descriptor = name && typeof registry.modelAliases === "function" ? registry.modelAliases().find((candidate) => candidate.name === name) : undefined;
    if (descriptor && errorCode(error) !== "CANCELLED") throw new WorkflowError(errorCode(error) ?? "CONFIG_ERROR", `${errorText(error)} (extension: ${descriptor.headline})`);
    throw error;
  }
}

export default function workflowExtension(pi: WorkflowExtensionAPI, home?: string, clipboard = copyToClipboard, transport: AgentTransport = localAgentTransport, agentDir?: string, additionalSkillPaths: readonly string[] = []) {
  beginWorkflowExtensionLoading();
  const registry = loadingRegistry();
  const extensionAgentDir = agentDir ?? getAgentDir();
  const registerEntryRenderer = piHostCapabilities(pi).registerEntryRenderer;
  registerEntryRenderer?.<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, (entry) => {
    const data = entry.data;
    return textBlock(data ? `Workflow ${data.workflowName}: ${data.message}` : "");
  });
  const logBridge = (store: RunStore, lifecycle: RunLifecycle, workflowName: string) => async (message: string) => {
    const timestamp = Date.now();
    const bounded = utf8Prefix(message, DELIVERY_LIMIT_BYTES);
    await lifecycle.enter();
    try {
      const active = runs.get(store.runId);
      const update = active?.foreground ? active.update : undefined;
      if (update) {
        const event = { type: "log", message: bounded, timestamp };
        const persisted = await store.updateState((current) => current.delivery?.mode === "foreground" && current.delivery.state === "attached" ? { ...current, events: [...(current.events ?? []), event] } : current);
        if (persisted.events?.at(-1) === event) { update(workflowToolUpdate(persisted)); return; }
      }
      pi.appendEntry<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, { workflowName, message: bounded });
    } finally { await lifecycle.leave(); }
  };
  const eventPublisher = new WorkflowEventPublisher(piHostCapabilities(pi).events);
  pi.on("resources_discover", () => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });
  const runs = new Map<string, WorkflowRunRecord>();
  let releaseWorkflowRegistry: (() => void) | undefined;
  let providerRecoveryQueue = Promise.resolve();
  const enqueueProviderRecovery = <T>(task: () => Promise<T>): Promise<T> => { const next = providerRecoveryQueue.then(task, task); providerRecoveryQueue = next.then(() => undefined, () => undefined); return next; };
  // The recovery adapter implements only getAvailableSnapshot, refresh, getModel, and getError from ModelRuntime, plus setDefaultModelAndProvider from SettingsManager; the constructor below is the one third-party boundary because it cannot create another authenticated runtime.
  type ModelSelectorRuntimeAdapter = Pick<ModelRuntime, "getAvailableSnapshot" | "refresh" | "getModel" | "getError">;
  type ModelSelectorSettingsAdapter = Pick<SettingsManager, "setDefaultModelAndProvider">;
  const createProviderErrorRecovery = (host: unknown, fallbackModels: ReadonlySet<string>, abort: () => void) => {
    if (!object(host) || host.mode !== "tui" || host.hasUI !== true) return undefined;
    const ui = object(host.ui) ? host.ui : undefined;
    const uiCapabilities = uiHostCapabilities(ui);
    const select = uiCapabilities?.select;
    if (!select) return undefined;
    const hostModels = contextHostCapabilities(host).modelRegistry;
    const reportBlocked = (active: boolean, label?: string): void => { try { piHostCapabilities(pi).events?.emit(WORKFLOW_BLOCKED_EVENT, { active, ...(label === undefined ? {} : { label }) }); } catch { /* Workflow state is advisory and must not alter recovery. */ } };
    const choose = (title: string, options: string[]) => select.call(ui, title, options);
    const chooseModel = async (failure: AgentProviderFailure): Promise<string | undefined> => {
      const custom = uiCapabilities.custom;
      const getAvailable = hostModels?.getAvailable;
      if (!custom || !getAvailable) {
        const available = getAvailable ? getAvailable().map((model) => `${model.provider}/${model.id}`) : [...fallbackModels];
        return choose(`Available models for subagent "${failure.label}"`, [...new Set(available)].sort());
      }
      const available = getAvailable();
      const current = hostModels.find?.(failure.provider, failure.model) ?? available.find((model) => model.provider === failure.provider && model.id === failure.model);
      const runtime: ModelSelectorRuntimeAdapter = {
        getAvailableSnapshot: getAvailable,
        refresh: async ({ signal }: { signal?: AbortSignal } = {}) => {
          if (signal?.aborted) return { aborted: true, errors: new Map<string, Error>() };
          try { await hostModels.refresh?.(); return { aborted: false, errors: new Map<string, Error>() }; }
          catch (error) { return { aborted: false, errors: new Map([["models", error instanceof Error ? error : new Error(String(error))]]) }; }
        },
        getModel: (provider: string, model: string) => hostModels.find?.(provider, model) ?? getAvailable().find((candidate) => candidate.provider === provider && candidate.id === model),
        getError: () => hostModels.getError?.(),
      };
      const settings: ModelSelectorSettingsAdapter = { setDefaultModelAndProvider() {} };
      return await custom.call(ui, (tui, _theme, _keybindings, done) => new ModelSelectorComponent(tui, current, settings as SettingsManager, runtime as ModelRuntime, [], (model) => { done(`${model.provider}/${model.id}`); }, () => { done(undefined); })) as string | undefined;
    };
    return (failure: AgentProviderFailure): Promise<AgentProviderRecovery> => enqueueProviderRecovery(async () => {
      reportBlocked(true, `Subagent "${failure.label}" failed`);
      try {
        for (;;) {
          const action = await choose(`Subagent "${failure.label}" failed\nCurrent provider/model: ${failure.provider}/${failure.model}\nProvider error: ${failure.error}\nChoose what to do`, ["Retry", "Change model", "Abort workflow"]);
          if (action === "Retry") return "retry";
          if (action === "Change model") {
            const selected = await chooseModel(failure);
            if (selected) return { model: selected };
            continue;
          }
          abort();
          return "abort";
        }
      } finally {
        reportBlocked(false);
      }
    });
  };
  type ForegroundDetachResult = { runId: string; state: "running"; detached: true; run: PersistedRun };
  type ForegroundDelivery = { store: RunStore; inline: boolean; detached: boolean; detach: () => Promise<ForegroundDetachResult>; timer?: ReturnType<typeof setTimeout> };
  type PendingFailureDiagnostic = { diagnostic: WorkflowFailureDiagnostics; run: PersistedRun };
  const pendingFailureDiagnostics = new Map<string, PendingFailureDiagnostic>();
  const foregroundDeliveries = new Map<string, ForegroundDelivery>();
  const foregroundResumeClaims = new WeakSet<RunStore>();
  const terminalDeliveryQueues = new WeakMap<RunStore, Promise<void>>();
  const liveActivities = new Map<string, Map<string, AgentActivity>>();
  const liveEventTimes = new Map<string, Map<string, number>>();
  const liveAgentSessions = new Map<string, import("./types.js").WorkflowAgentSession>();
  const liveAgentPrepared = new Map<string, Readonly<import("./types.js").PreparedAgentSession>>();
  const liveAgentHandoffs = new Map<string, import("./types.js").LiveSessionHandoff>();
  const setLiveAgentSession = (runId: string, agentId: string, session?: import("./types.js").WorkflowAgentSession) => { const key = `${runId}:${agentId}`; if (session) liveAgentSessions.set(key, session); else liveAgentSessions.delete(key); };
  const setLiveAgentHandoff = (runId: string, agentId: string, attempt: AgentAttempt) => {
    const key = `${runId}:${agentId}`;
    if (attempt.liveSession && attempt.prepared && attempt.handoff) { liveAgentPrepared.set(key, attempt.prepared); liveAgentHandoffs.set(key, attempt.handoff); } else { liveAgentPrepared.delete(key); liveAgentHandoffs.delete(key); }
  };
  const setLiveActivity = (runId: string, agentId: string, activity?: AgentActivity) => {
    const activities = liveActivities.get(runId);
    if (activity) {
      if (activities) activities.set(agentId, activity);
      else liveActivities.set(runId, new Map([[agentId, activity]]));
    } else {
      activities?.delete(agentId);
      if (activities?.size === 0) liveActivities.delete(runId);
    }
  };
  const setLiveEventTime = (runId: string, agentId: string, timestamp?: number) => {
    if (timestamp === undefined) return;
    const timestamps = liveEventTimes.get(runId);
    if (timestamps) timestamps.set(agentId, timestamp);
    else liveEventTimes.set(runId, new Map([[agentId, timestamp]]));
  };
  const withLiveActivities = (run: PersistedRun): PersistedRun => {
    const activities = liveActivities.get(run.id);
    const timestamps = liveEventTimes.get(run.id);
    if (!activities?.size && !timestamps?.size) return run;
    return { ...run, agents: run.agents.map((agent) => {
      const activity = activities?.get(agent.id);
      const lastEventAt = timestamps?.get(agent.id);
      if (activity === undefined && lastEventAt === undefined) return agent;
      return { ...agent, ...(activity === undefined ? {} : { activity }), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
    }) };
  };
  const terminalRunStates = new Map<string, "completed" | "failed" | "stopped">();
  let sessionLease: SessionLease | undefined;
  let sessionLeasePromise: Promise<SessionLease> | undefined;
  const ensureSessionLease = async (cwd: string, sessionId: string) => {
    if (sessionLease?.active) return;
    const pending = sessionLeasePromise ?? (sessionLeasePromise = acquireSessionLease(cwd, sessionId, home));
    try { sessionLease = await pending; }
    finally { if (sessionLeasePromise === pending) sessionLeasePromise = undefined; }
  };
  const releaseSessionLease = async () => {
    const lease = sessionLease ?? await sessionLeasePromise?.catch(() => undefined);
    sessionLease = undefined;
    sessionLeasePromise = undefined;
    await lease?.release();
  };
  const persistRunState = async (store: RunStore, metadata: WorkflowMetadata, update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>): Promise<PersistedRun> => {
    const persisted = await store.updateState(update);
    await eventPublisher.budget(store, metadata, persisted);
    return persisted;
  };
  pi.on("tool_result", async (event) => {
    const delivery = event.toolName === "workflow" ? foregroundDeliveries.get(event.toolCallId) : undefined;
    if (delivery && !delivery.detached) {
      if (delivery.timer) clearTimeout(delivery.timer);
      delivery.inline = true;
      await delivery.store.updateState((current) => {
        if (current.delivery?.toolCallId !== event.toolCallId || current.delivery.state === "delivered") return current;
        return { ...current, delivery: { ...current.delivery, state: "delivered" } };
      });
      foregroundDeliveries.delete(event.toolCallId);
    }
    if (event.toolName !== "workflow" || !event.isError) return;
    const pending = pendingFailureDiagnostics.get(event.toolCallId);
    if (!pending) return;
    pendingFailureDiagnostics.delete(event.toolCallId);
    return { content: [{ type: "text" as const, text: serializeWorkflowFailureDiagnostics(pending.diagnostic) }], details: { ...pending.diagnostic, run: pending.run }, isError: true };
  });
  const deliverTerminal = (store: RunStore, content: string | (() => string | Promise<string>), failure = false): Promise<void> => {
    const previous = terminalDeliveryQueues.get(store) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      let claimed: boolean | undefined;
      await store.updateState((current) => {
        if (failure && !FAILURE_DELIVERY_STATES.has(current.state)) return current;
        if (current.delivery?.state === "delivered") { foregroundResumeClaims.delete(store); return current; }
        if (foregroundResumeClaims.has(store) && current.delivery?.mode === "foreground" && current.delivery.state === "attached") { foregroundResumeClaims.delete(store); return current; }
        if (current.delivery?.mode === "foreground" && current.delivery.state === "attached") { claimed = true; return { ...current, delivery: { ...current.delivery, state: "delivered" } }; }
        if (!current.delivery) { claimed = true; return current; }
        claimed = true;
        return { ...current, delivery: { ...current.delivery, mode: "background", state: "delivered" } };
      });
      if (claimed !== true) return;
      if (failure && !FAILURE_DELIVERY_STATES.has((await store.load()).run.state)) {
        await store.updateState((current) => !FAILURE_DELIVERY_STATES.has(current.state) && current.delivery?.state === "delivered" ? { ...current, delivery: { ...current.delivery, state: "pending" } } : current);
        return;
      }
      deliver(pi, typeof content === "function" ? await content() : content);
    });
    terminalDeliveryQueues.set(store, delivery.catch(() => undefined));
    return delivery;
  };
  const scheduleForegroundDelivery = (toolCallId: string, send: () => Promise<void>): void => {
    const delivery = foregroundDeliveries.get(toolCallId);
    if (!delivery || delivery.inline || typeof pi.sendMessage !== "function") return;
    //NOTE: Give Pi one event-loop turn to deliver an uninterrupted tool result before promoting.
    delivery.timer = setTimeout(() => {
      delete delivery.timer;
      void send().finally(() => foregroundDeliveries.delete(toolCallId));
    }, 0);
  };
  const foregroundDeliveryCandidates = (runId: string): Array<[string, ForegroundDelivery]> => [...foregroundDeliveries.entries()].filter(([, delivery]) => runs.has(delivery.store.runId) && !delivery.inline && !delivery.detached && delivery.store.runId === runId);
  const moveForegroundToBackground = async (runId: string): Promise<ForegroundDetachResult> => {
    const candidates = foregroundDeliveryCandidates(runId);
    if (!candidates.length) throw new WorkflowError("RUN_NOT_FOUND", `No attached foreground workflow ${runId}`);
    return candidates[0]?.[1].detach() ?? fail("RUN_NOT_FOUND", "No attached foreground workflow is running");
  };
  const isForegroundAttached = (runId: string): boolean => foregroundDeliveryCandidates(runId).length > 0;
  const phaseBridge = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle) => {
    let cursor = 0;
    return async (phase: string): Promise<void> => {
      await scheduler.flush();
      await lifecycle.enter();
      try {
        let previousPhase: string | undefined;
        const persisted = await persistRunState(store, metadata, (current) => {
          previousPhase = current.phase;
          const history = current.phaseHistory ?? [];
          if (history[cursor]?.phase === phase) {
            const phaseHistoryIndex = cursor;
            cursor += 1;
            return { ...current, phase, phaseHistoryIndex };
          }
          const phaseHistoryIndex = history.length;
          cursor = history.length + 1;
          return { ...current, phase, phaseHistoryIndex, phaseHistory: [...history, { phase, afterAgent: current.agents.length }] };
        });
        await eventPublisher.phase(store, metadata, previousPhase, phase);
        runs.get(store.runId)?.update?.(workflowToolUpdate(persisted));
      } finally { await lifecycle.leave(); }
    };
  };
  const persistWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<WorktreeReference> => {
    const existing = (await store.worktrees()).some((worktree) => worktree.owner === owner);
    const worktree = await store.worktree(owner);
    if (!existing && await store.ownsWorktree(owner)) await eventPublisher.worktree(store, metadata, worktree);
    return worktree;
  };
  const resolveWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<Readonly<WorkflowWorktreeReference>> => {
    const run = runs.get(store.runId);
    if (!run) fail("INTERNAL_ERROR", `Unknown production run: ${store.runId}`);
    await run.lifecycle.enter();
    try {
      const worktree = await persistWorktree(store, metadata, owner);
      return { path: worktree.path, branch: worktree.branch };
    } finally { await run.lifecycle.leave(); }
  };
  const shellForRun = async (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, command: string, options: ShellOptions, signal: AbortSignal, identity: ShellIdentity): Promise<ShellResult> => {
    await lifecycle.enter();
    try {
      const path = shellIdentityPath(identity);
      const replayed = await store.replay(path);
      if (replayed) return readShellResult(replayed.value);
      const shellStartedAt = Date.now();
      let shellPhaseIndex = -1;
      const started = await persistRunState(store, metadata, (current) => {
        const history = current.phaseHistory ?? [];
        if (current.phase !== undefined) shellPhaseIndex = current.phaseHistoryIndex ?? (history.length ? history.length - 1 : 0);
        const phaseActivities = [...(current.activeShellsByPhase ?? [])];
        const phaseActivityIndex = phaseActivities.findIndex(({ phaseIndex }) => phaseIndex === shellPhaseIndex);
        const nextPhaseActivities = phaseActivityIndex >= 0
          ? phaseActivities.map((activity, index) => index === phaseActivityIndex ? { ...activity, active: activity.active + 1 } : activity)
          : [...phaseActivities, { phaseIndex: shellPhaseIndex, active: 1, startedAt: shellStartedAt }];
        const activeShells = current.activeShells ?? 0;
        return { ...current, activeShells: activeShells + 1, ...(activeShells > 0 && current.activeShellStartedAt !== undefined ? {} : { activeShellStartedAt: shellStartedAt }), activeShellsByPhase: nextPhaseActivities };
      });
      runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(started)));
      try {
        const cwd = identity.worktreeOwner ? (await persistWorktree(store, metadata, identity.worktreeOwner)).cwd : store.cwd;
        const result = await executeShellCommand(command, options, signal, cwd);
        if (!jsonValue(result)) fail("SHELL_FAILED", "Shell result is not JSON-compatible");
        await store.complete(path, result);
        return result;
      } finally {
        const stopped = await persistRunState(store, metadata, (current) => {
          const phaseActivities = [...(current.activeShellsByPhase ?? [])];
          const phaseActivityIndex = phaseActivities.findIndex(({ phaseIndex }) => phaseIndex === shellPhaseIndex);
          const phaseActivity = phaseActivities[phaseActivityIndex];
          const nextPhaseActivities = phaseActivityIndex < 0 ? phaseActivities : phaseActivity && phaseActivity.active > 1
            ? phaseActivities.map((activity, index) => index === phaseActivityIndex ? { ...activity, active: activity.active - 1 } : activity)
            : phaseActivities.filter((_, index) => index !== phaseActivityIndex);
          const activeShells = Math.max(0, (current.activeShells ?? 0) - 1);
          if (activeShells > 0) {
            const next = { ...current, activeShells };
            if (nextPhaseActivities.length) next.activeShellsByPhase = nextPhaseActivities; else delete next.activeShellsByPhase;
            return next;
          }
          const next = { ...current };
          delete next.activeShells;
          delete next.activeShellStartedAt;
          delete next.activeShellsByPhase;
          return next;
        });
        runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(stopped)));
      }
    } finally { await lifecycle.leave(); }
  };
  const lifecycleFor = (store: RunStore, state: RunState, budget: WorkflowBudgetRuntime, metadata: WorkflowMetadata) => new RunLifecycle(state, async (next, previous, reason) => {
    if (next !== "pausing") budget.transition(next);
    const persisted = await persistRunState(store, metadata, (current) => {
      const nextRun = { ...current, state: next, ...budget.snapshot() };
      if (next === "running" || next === "completed") { delete nextRun.error; delete nextRun.failedAt; }
      if (next === "running" && (previous === "paused" || previous === "interrupted" || previous === "budget_exhausted") && nextRun.delivery?.state === "delivered") nextRun.delivery = { ...nextRun.delivery, state: "pending" };
      return nextRun;
    });
    await eventPublisher.runState(store, metadata, previous, next, reason);
    runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(persisted)));
  });
  const scheduler = new FairAgentScheduler(async ({ id, runId, tuiIndex, parentId, prompt, options, signal, setSteer }) => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${runId}`);
    try {
      const budget = run.budget.forAgent(id);
      const onProgress = async (progress: AgentProgress) => {
        let runState: PersistedRun;
        if (progress.persist) {
          runState = await persistRunState(run.store, run.metadata, (current) => current.agents.some((agent) => agent.id === id) ? { ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? agentWithProgress(agent, progress) : agent) } : current);
        } else {
          const loaded = await run.store.load();
          if (!loaded.run.agents.some((agent) => agent.id === id)) return;
          runState = { ...loaded.run, ...run.budget.snapshot(), agents: loaded.run.agents.map((agent) => agent.id === id ? agentWithProgress(agent, progress) : agent) };
        }
        if (!runState.agents.some((agent) => agent.id === id)) return;
        setLiveActivity(runId, id, progress.activity);
        setLiveEventTime(runId, id, progress.lastEventAt);
        run.update?.(workflowToolUpdate(withLiveActivities(runState)));
      };
      const onAttempt = async (attempt: AgentAttempt) => {
        setLiveAgentSession(runId, id, attempt.liveSession);
        setLiveAgentHandoff(runId, id, attempt);
        await scheduler.flush();
        scheduler.attemptStarted(id);
        const lastEventAt = Date.now();
        setLiveEventTime(runId, id, lastEventAt);
        await scheduler.flush();
        const before = (await run.store.load()).run;
        await persistActiveAgentAttempt(run.store, id, attempt);
        const active = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, active.agents);
        const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? { ...agent, lastEventAt } : agent) }));
        run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      };
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, tuiIndex, tuiLabel: options.requestedLabel ?? options.label, onProgress, onAttempt, budget, ...(run.providerErrorRecovery ? { providerErrorRecovery: run.providerErrorRecovery } : {}), ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}) } : options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}), ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.role ? { role: options.role } : {}), ...(options.role ? {} : { tools: options.tools }), effectiveTools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}), ...(options.agentIdentity ? { agentIdentity: options.agentIdentity } : {}) }, signal, scheduler.toolsFor(id, (role, tools, model, inheritedTools, thinking) => run.executor.resolve({ label: "child", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(tools !== undefined ? { tools } : {}) }, inheritedTools).tools), setSteer, () => { scheduler.cancelChildren(id); scheduler.retry(id); });
      const before = (await run.store.load()).run;
      await persistAgentAttempts(run.store, id, result.attempts);
      const completed = (await run.store.load()).run;
      await eventPublisher.agentStates(run.store, run.metadata, before.agents, completed.agents);
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      setLiveActivity(runId, id);
      setLiveAgentSession(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      return result.value;
    } catch (error) {
      setLiveAgentSession(runId, id);
      const attempts = getAgentAttempts(error);
      if (attempts?.length) {
        const before = (await run.store.load()).run;
        await persistAgentAttempts(run.store, id, attempts);
        const failed = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, failed.agents);
      }
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      setLiveActivity(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      throw error;
    }
  }, 16, async (runId, ownership) => {
    const run = runs.get(runId);
    if (!run) return;
    await run.store.saveOwnership(ownership);
    let previousAgents: readonly AgentRecord[] = [];
    const runState = await persistRunState(run.store, run.metadata, (current) => {
      previousAgents = current.agents;
      const existing = new Map(current.agents.map((agent) => [agent.id, agent]));
      const agents = ownership.map((node) => {
        const previous = existing.get(node.id);
        const requested = { label: node.options.label, workflowName: run.metadata.name, ...(node.options.model ? { model: node.options.model } : {}), ...(node.options.thinking ? { thinking: node.options.thinking } : {}), ...(node.options.role ? { role: node.options.role } : {}), effectiveTools: node.options.tools };
        let effective: { model: ModelSpec; requestedModel?: string; tools: readonly string[] };
        try { effective = run.executor.resolve(requested); }
        catch { effective = previous ? { model: previous.model, ...(previous.requestedModel ? { requestedModel: previous.requestedModel } : {}), tools: previous.tools } : { model: node.options.model ? modelSpec(node.options.model, run.model) : { ...run.model, ...(node.options.thinking ? { thinking: node.options.thinking } : {}) }, ...(node.options.model ? { requestedModel: node.options.model } : {}), tools: node.options.tools }; }
        const resultPath = !node.parentId && node.options.agentIdentity ? agentIdentityPath(node.options.agentIdentity) : undefined;
        const nodeRole = roleNameOf(node.options.role);
        const now = Date.now();
        const lastEventAt = node.state === "running" ? previous?.state === "running" && previous.lastEventAt !== undefined ? previous.lastEventAt : now : previous?.lastEventAt;
        const startedAt = previous?.startedAt ?? (node.state === "running" ? now : undefined);
        const durationMs = previous?.durationMs ?? (SETTLED_AGENT_STATES.has(node.state) && startedAt !== undefined ? Math.max(0, now - startedAt) : undefined);
        return { ...(previous?.systemPrompt === undefined ? {} : { systemPrompt: previous.systemPrompt }), ...(node.prompt !== undefined ? { prompt: node.prompt } : previous?.prompt !== undefined ? { prompt: previous.prompt } : {}), id: node.id, name: node.label, ...(node.options.requestedLabel ? { label: node.options.requestedLabel } : {}), path: node.id, state: node.state, ...(node.parentId ? { parentId: node.parentId } : {}), structuralPath: [...(node.options.agentIdentity?.structuralPath ?? [])], ...(resultPath ? { resultPath } : {}), ...(node.options.parentBreadcrumb ? { parentBreadcrumb: node.options.parentBreadcrumb } : {}), ...(node.options.worktreeOwner ? { worktreeOwner: node.options.worktreeOwner } : {}), ...(nodeRole ? { role: nodeRole } : {}), ...(effective.requestedModel ? { requestedModel: effective.requestedModel } : {}), model: effective.model, tools: effective.tools, attempts: previous?.attempts ?? 0, ...(startedAt === undefined ? {} : { startedAt }), ...(durationMs === undefined ? {} : { durationMs }), ...(previous?.attemptDetails ? { attemptDetails: previous.attemptDetails } : {}), ...(previous?.accounting ? { accounting: previous.accounting } : {}), ...(previous?.toolCalls ? { toolCalls: previous.toolCalls } : {}), ...(previous?.activity ? { activity: previous.activity } : {}), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
      });
      return { ...current, agents };
    });
    await eventPublisher.agentStates(run.store, run.metadata, previousAgents, runState.agents);
    run.update?.(workflowToolUpdate(withLiveActivities(runState)));
  });
  const cleanupTerminalRun = async (runId: string): Promise<void> => {
    const run = runs.get(runId);
    if (!run || !HARD_TERMINAL_RUN_STATES.has(run.lifecycle.state)) return;
    await scheduler.cancelRun(runId);
    await scheduler.flush();
    if (runs.get(runId) !== run) return;
    scheduler.removeRun(runId);
    terminalRunStates.set(runId, run.lifecycle.state as "completed" | "failed" | "stopped");
    run.checkpointResolvers.clear();
    liveActivities.delete(runId);
    liveEventTimes.delete(runId);
    for (const key of liveAgentSessions.keys()) if (key.startsWith(`${runId}:`)) liveAgentSessions.delete(key);
    for (const key of liveAgentPrepared.keys()) if (key.startsWith(`${runId}:`)) liveAgentPrepared.delete(key);
    for (const key of liveAgentHandoffs.keys()) if (key.startsWith(`${runId}:`)) liveAgentHandoffs.delete(key);
    eventPublisher.removeRun(runId);
    runs.delete(runId);
  };
  type WorkflowStopResult = { runId: string; state: RunState | "unknown"; stopped: boolean; reason?: "unknown_run" | "already_terminal" };
  const stopWorkflowRun = async (runId: string): Promise<WorkflowStopResult> => {
    const run = runs.get(runId);
    const terminalState = terminalRunStates.get(runId);
    if (!run) return terminalState ? { runId, state: terminalState, stopped: false, reason: "already_terminal" } : { runId, state: "unknown", stopped: false, reason: "unknown_run" };
    const state = run.lifecycle.state;
    if (state === "completed" || state === "failed" || state === "stopped") return { runId, state, stopped: false, reason: "already_terminal" };
    await run.lifecycle.terminal("stopped");
    run.abortController.abort();
    run.execution?.cancel();
    await scheduler.cancelRun(run.store.runId);
    await scheduler.flush();
    await cleanupTerminalRun(runId);
    return { runId, state: "stopped", stopped: true };
  };
  type WorkflowStatusAgent = { id: string; label?: string; path: string; state: AgentRecord["state"]; activity?: AgentActivity; lastEventAt?: number; accounting?: NonNullable<AgentRecord["accounting"]> };
  type WorkflowStatusResult = { runId: string; workflowName: string; state: RunState; error?: { code: WorkflowErrorCode; message: string }; failedAt?: string; budget?: NonNullable<PersistedRun["budget"]>; usage?: NonNullable<PersistedRun["usage"]>; phase?: string; delivery?: Pick<NonNullable<PersistedRun["delivery"]>, "mode" | "state">; agents: readonly WorkflowStatusAgent[] };
  const workflowStatusRun = async (runId: string, context: unknown): Promise<WorkflowStatusResult> => {
    const host = object(context) ? context : {};
    const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
    if (!cwd || !runId.trim()) throw new WorkflowError("RUN_NOT_FOUND", `Unknown workflow run ${runId} in the current project`);
    for (const sessionId of await listPersistedSessionIds(cwd, home)) {
      if (!(await listRunIds(cwd, sessionId, home, false)).includes(runId)) continue;
      const store = new RunStore(cwd, sessionId, runId, home);
      try {
        const run = withLiveActivities(await store.loadStatus());
        const failedAt = run.failedAt ?? run.error?.failedAt;
        return {
          runId: run.id, workflowName: run.workflowName, state: run.state,
          ...(run.error ? { error: { code: run.error.code, message: run.error.message } } : {}),
          ...(failedAt ? { failedAt } : {}),
          ...(run.budget === undefined ? {} : { budget: run.budget, ...(run.usage === undefined ? {} : { usage: run.usage }) }),
          ...(run.phase ? { phase: run.phase } : {}),
          ...(run.delivery ? { delivery: { mode: run.delivery.mode, state: run.delivery.state } } : {}),
          agents: run.agents.map((agent) => ({ id: agent.id, ...(agent.label === undefined ? {} : { label: agent.label }), path: agent.path, state: agent.state, ...(agent.activity === undefined ? {} : { activity: agent.activity }), ...(agent.lastEventAt === undefined ? {} : { lastEventAt: agent.lastEventAt }), ...(agent.accounting === undefined ? {} : { accounting: agent.accounting }) })),
        };
      } catch {
        continue;
      }
    }
    throw new WorkflowError("RUN_NOT_FOUND", `Unknown workflow run ${runId} in the current project`);
  };
  const answerCheckpoint = async (runId: string, name: string, approved: boolean, silent = false) => {
    const run = runs.get(runId);
    if (!run) return false;
    const checkpoint = await run.store.answerCheckpoint(name, approved);
    if (!checkpoint) return false;
    await eventPublisher.checkpoint(run.store, run.metadata, checkpoint.name, approved ? "approved" : "rejected");
    if ((await run.store.awaitingCheckpoints()).length === 0) await run.lifecycle.resolveAwaitingInput();
    run.checkpointResolvers.get(checkpoint.path)?.(approved);
    run.checkpointResolvers.delete(checkpoint.path);
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} checkpoint ${name}: ${approved ? "Approved" : "Rejected"}.`);
    return true;
  };
  const backgroundCheckpointDeliveries = new Set<string>();
  const deliverBackgroundCheckpoint = (workflowName: string, runId: string, checkpoint: { path: string; name: string; prompt: string; context: JsonValue }): void => {
    const key = `${runId}:${checkpoint.path}`;
    if (backgroundCheckpointDeliveries.has(key)) return;
    backgroundCheckpointDeliveries.add(key);
    deliver(pi, `Workflow ${workflowName} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean | (() => boolean), ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, headless = false) => {
    const checkpointCounters = new Map<string, number>();
    const isForeground = () => typeof foreground === "function" ? foreground() : foreground;
    return async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
      const input = validateCheckpoint(raw);
      const label = nextNamedOccurrence(checkpointCounters, input.name);
      const path = operationPath("checkpoint", label);
      if (headless) fail("RESUME_INCOMPATIBLE", "Headless CLI checkpoints are unsupported");
      if (isForeground() && !ui?.select) fail("RESUME_INCOMPATIBLE", "Foreground checkpoints require UI");
      const alreadyAwaiting = (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.path === path);
      const replayed = await store.awaitCheckpoint({ ...input, name: label, path });
      if (replayed !== undefined) return replayed;
      if (!alreadyAwaiting) await eventPublisher.checkpoint(store, metadata, label, "awaiting");
      const run = runs.get(runId);
      await run?.lifecycle.enterAwaitingInput();
      if (!alreadyAwaiting && (!isForeground() || !ui?.select)) deliverBackgroundCheckpoint(metadata.name, runId, { ...input, name: label, path });
      const decision = new Promise<boolean>((resolve, reject) => {
        run?.checkpointResolvers.set(path, resolve);
        if (signal.aborted) reject(new WorkflowError("CANCELLED", "Workflow cancelled"));
        else signal.addEventListener("abort", () => { run?.checkpointResolvers.delete(path); reject(new WorkflowError("CANCELLED", "Workflow cancelled")); }, { once: true });
      });
      const answered = await store.awaitCheckpoint({ ...input, name: label, path });
      if (answered !== undefined) {
        if ((await store.awaitingCheckpoints()).length === 0) await run?.lifecycle.resolveAwaitingInput();
        run?.checkpointResolvers.get(path)?.(answered);
        run?.checkpointResolvers.delete(path);
      }
      if (ui?.select && isForeground()) void (async () => {
        while (!signal.aborted && run?.checkpointResolvers.has(path)) {
          const choice = await ui.select?.(input.prompt, ["Approve", "Reject"]);
          if (!choice) {
            if (isForeground()) continue;
            deliverBackgroundCheckpoint(metadata.name, runId, { ...input, name: label, path });
            return;
          }
          if (await answerCheckpoint(runId, label, choice === "Approve", true)) return;
        }
        if (!isForeground() && !signal.aborted && run?.checkpointResolvers.has(path)) deliverBackgroundCheckpoint(metadata.name, runId, { ...input, name: label, path });
      })().catch(() => undefined);
      return decision;
    };
  };

  pi.registerTool({
    name: "workflow_respond",
    label: "Workflow Respond",
    description: "Approve or reject one pending workflow checkpoint or budget decision",
    parameters: Type.Object({ runId: Type.String(), name: Type.Optional(Type.String()), proposalId: Type.Optional(Type.String()), approved: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (params.proposalId) {
          const result = await recovery.answerBudgetDecision(params.runId, params.proposalId, params.approved, false, ctx, signal);
          if (!result) { const denied = { state: "budget_exhausted" as const, approved: false, reason: "proposal_not_pending" }; return { content: [{ type: "text" as const, text: JSON.stringify(denied) }], details: denied }; }
          return { content: [{ type: "text" as const, text: completionControlContent(result, params.runId) }], details: { ...result, reason: params.approved ? "approved" : "rejected" } };
        }
        if (!params.name) throw new WorkflowError("INVALID_METADATA", "workflow_respond requires name or proposalId");
        const accepted = await answerCheckpoint(params.runId, params.name, params.approved);
        return { content: [{ type: "text" as const, text: accepted ? "Checkpoint response accepted." : "Checkpoint is not awaiting a response." }], details: { accepted, state: accepted ? "checkpoint_answered" : "not_pending", approved: params.approved, reason: "checkpoint" } };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_respond", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_respond", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.registerTool({
    name: "workflow_stop",
    label: "Workflow Stop",
    description: "Stop an active workflow run by ID",
    parameters: Type.Object({ runId: Type.String() }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const result = await stopWorkflowRun(params.runId);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_stop", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_stop", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: "Read a compact summary of a workflow run in the current project",
    parameters: WORKFLOW_STATUS_PARAMETERS,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try { const result = await workflowStatusRun(params.runId, ctx); return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_status", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_status", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  let catalogRegistered = false;
  let sessionStarted = false;
  const registerCatalog = (cwd: string, trustedProject: boolean) => {
    if (catalogRegistered || !pi.getActiveTools().includes("workflow")) return;
    const catalog = registry.catalog({ cwd, projectTrusted: trustedProject, globalSettingsPath: workflowSettingsPath(extensionAgentDir) });
    const hasAliases = Object.keys(catalog.modelAliases ?? {}).length > 0 || Boolean(catalog.modelAliasEntries?.length);
    const hasSettings = catalog.settings !== undefined && [catalog.settings.globalSettingsPath, catalog.settings.projectSettingsPath].some((path) => existsSync(path));
    if (!catalog.functions.length && !hasAliases && !hasSettings) return;
    pi.registerTool({
      name: "workflow_catalog",
      label: "Workflow Catalog",
      description: "List reusable workflow functions and model aliases; pass `name` to load one entry in full",
      parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Registered function or model alias name for full detail" })) }, { additionalProperties: false }),
      async execute(_id, params = {}) {
        const context = { cwd, projectTrusted: trustedProject, globalSettingsPath: workflowSettingsPath(extensionAgentDir) };
        const result = params.name === undefined ? registry.catalogIndex(context) : registry.catalogDetail(params.name, context);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      },
      renderCall(args, theme) {
        const title = theme.fg("toolTitle", theme.bold("workflow_catalog"));
        return styledTextBlock(args.name === undefined ? title : `${title} ${theme.fg("accent", args.name)}`);
      },
      renderResult(result, options, theme) {
        return workflowCatalogBlock(formatWorkflowCatalog(catalogResultValue(result), options.expanded, theme), options.expanded);
      },
    });
    catalogRegistered = true;
  };
  const createAgentExecutor = (root: Omit<import("./agent-execution.js").AgentExecutionRoot, "agentDir" | "agentSetupHooks">) => new WorkflowAgentExecutor({ ...root, agentDir: extensionAgentDir, ...(additionalSkillPaths.length ? { additionalSkillPaths } : {}), agentSetupHooks: registry.agentSetupHooks() }, transport);
  const activeSnapshotTools = (tools: readonly string[], active: ReadonlySet<string> | "session") => active === "session"
    ? new Set(tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog"))
    : new Set(tools.filter((tool) => active.has(tool) || tool === "workflow_catalog"));
  const resumeLaunchPrologue = async (input: {
    snapshot: Readonly<LaunchSnapshot>;
    cwd: string;
    trustedProject: boolean;
    rootModel: ModelSpec;
    modelRegistry?: ModelRegistryCapability | undefined;
    signal: AbortSignal;
    resolvedAliases?: Readonly<Record<string, string>>;
    blockedAliases?: ReadonlySet<string>;
    blockedAliasTargets?: Readonly<Record<string, string>>;
    withPreflight: boolean;
  }) => {
    const active = new Set(pi.getActiveTools().filter((tool) => !INTERNAL_WORKFLOW_TOOLS.includes(tool)));
    const missing = input.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath(extensionAgentDir);
    const resolution = resolveWorkflowSettings(input.cwd, input.trustedProject, settingsPath);
    const currentPolicy = resolveAgentResourcePolicy(input.cwd, input.trustedProject, settingsPath);
    const staticAliases = resolution.effective.modelAliases ?? {};
    const previousAliases = input.snapshot.modelAliases ?? input.snapshot.settings.modelAliases ?? {};
    const inventory = modelInventory(input.rootModel, input.modelRegistry);
    const knownModels = input.modelRegistry ? inventory.knownModels : new Set([...input.snapshot.models, ...inventory.knownModels]);
    const availableModels = input.modelRegistry ? inventory.availableModels : new Set([...input.snapshot.models, ...inventory.availableModels]);
    const currentAliases = input.resolvedAliases ?? (await resolveLaunchAliases(registry, staticAliases, { cwd: input.cwd, projectTrusted: input.trustedProject, rootModel: input.rootModel, knownModels, availableModels, signal: input.signal }, availableModels, knownModels, settingsPath)).aliases;
    const blockedAliases = input.blockedAliases ?? new Set(Object.keys(previousAliases).filter((name) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const blockedAliasTargets = input.blockedAliasTargets ?? Object.fromEntries(Object.entries(previousAliases).filter(([name]) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const script = input.withPreflight ? input.snapshot.script : undefined;
    if (script !== undefined) {
      const resumeAliases = { ...previousAliases, ...currentAliases };
      preflight(script, { models: availableModels, tools: active, agentTypes: new Set(input.snapshot.agentTypes), modelAliases: resumeAliases, knownModels, settingsPath, skipModelAvailability: true }, input.snapshot.schemas, input.snapshot.metadata, true);
    }
    const refreshed = resumedSnapshotSettings(input.snapshot, resolution, currentAliases);
    const snapshot = createLaunchSnapshot({ ...input.snapshot, settingsPath, ...refreshed, modelAliases: currentAliases });
    return { active, settingsPath, resolution, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot, script };
  };
  const workflowAgentHandler = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, executor: WorkflowAgentExecutor, cwd: string, runId: string, captureRole?: (role: string, model: ModelSpec) => Promise<void>) => async (prompt: string, options: Readonly<Record<string, JsonValue>>, agentSignal: AbortSignal, identity: import("./types.js").AgentIdentity) => {
    await lifecycle.enter();
    try {
      const path = agentIdentityPath(identity);
      const replayed = await store.replay(path);
      if (replayed) {
        return replayed.value;
      }
      const worktree = agentWorktree(identity);
      const agentCwd = worktree.worktreeOwner ? (await persistWorktree(store, metadata, worktree.worktreeOwner)).cwd : cwd;
      const roleOption = options.role;
      const role = roleNameOf(roleOption);
      const model = typeof options.model === "string" ? options.model : undefined;
      const thinking = parseThinking(options.thinking);
      const requestedLabel = typeof options.label === "string" ? options.label : undefined;
      const resolved = executor.resolve({ label: requestedLabel ?? role ?? "agent", workflowName: metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(roleOption !== undefined ? { role: roleOption as string | RoleOverride } : {}), ...(Array.isArray(options.tools) ? { tools: options.tools as string[] } : {}) });
      if (role) await captureRole?.(role, resolved.model);
      const label = displayAgentName(requestedLabel, role, resolved.model);
      const tools = resolved.tools;
      const schema = object(options.outputSchema) ? options.outputSchema : undefined;
      const spawned = scheduler.spawn(runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd: agentCwd, tools, ...worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(roleOption !== undefined ? { role: roleOption as string | RoleOverride } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), agentOptions: options, agentIdentity: identity });
      const cancel = () => { scheduler.cancel(spawned.id); };
      if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
      const outcome = await spawned.result.finally(() => { agentSignal.removeEventListener("abort", cancel); });
      if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
      await store.complete(path, outcome.value);
      scheduler.releaseResult(spawned.id);
      return outcome.value;
    } finally { await lifecycle.leave(); }
  };
  const recovery = createWorkflowRecovery({
    pi, home, runs, scheduler, eventPublisher, persistRunState, projectTrusted, resumeHostContext, ensureSessionLease, createAgentExecutor, activeSnapshotTools, frozenResourcePolicy, resolveLaunchPrologue: resumeLaunchPrologue, workflowAgentHandler, shellForRun, resolveWorktree, checkpointBridge, phaseBridge, logBridge, lifecycleFor, createProviderErrorRecovery, cleanupTerminalRun, deliver: (content) => { deliver(pi, content); }, deliverTerminal, workflowToolUpdate, registry, modelSpec,
  });
  const resumeSelectedWorkflow = async (runId: string, foreground: boolean, context: unknown, budgetPatch?: unknown): Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: JsonValue }> => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run ${runId} in the current project and Pi session`);
    const host = object(context) ? context : {};
    const hasUI = host.hasUI === true;
    const capabilities = uiHostCapabilities(host.ui);
    const ui = capabilities?.select ? { select: capabilities.select } : {};
    const recoveryContext = { ...resumeHostContext(context) };
    if (run.lifecycle.state === "paused") {
      const wasAttached = isForegroundAttached(runId);
      if (!foreground && wasAttached) await moveForegroundToBackground(runId);
      if (foreground && !wasAttached) {
        run.foreground = true;
        const loaded = await run.store.load();
        await persistRunState(run.store, run.metadata, (current) => ({ ...current, delivery: { ...(current.delivery ?? {}), mode: "foreground", state: "attached" } }));
        await run.store.saveSnapshot(createLaunchSnapshot({ ...loaded.snapshot, launchMode: "foreground" }));
      } else if (!foreground) run.foreground = false;
      else run.foreground = true;
      await recovery.refreshPausedRunAliases(run, { ...recoveryContext, projectTrusted: projectTrusted(context) });
      const claimedForegroundResume = foreground && !wasAttached;
      if (claimedForegroundResume) foregroundResumeClaims.add(run.store);
      const completion = run.completion;
      await run.lifecycle.resume();
      if (!foreground) return { workflowName: run.metadata.name, state: "running", attached: false };
      if (!completion) { if (claimedForegroundResume) foregroundResumeClaims.delete(run.store); return { workflowName: run.metadata.name, state: "running", attached: false }; }
      try {
        const completed = await completion as { value?: JsonValue };
        if (!wasAttached) await run.store.updateState((current) => current.delivery?.mode === "foreground" && current.delivery.state === "attached" ? { ...current, delivery: { ...current.delivery, state: "delivered" } } : current);
        return { workflowName: run.metadata.name, state: "completed", attached: wasAttached, ...(!wasAttached && completed.value !== undefined ? { value: completed.value } : {}) };
      } catch (error) {
        if (!wasAttached) await run.store.updateState((current) => current.delivery?.mode === "foreground" && current.delivery.state === "attached" ? { ...current, delivery: { ...current.delivery, state: "delivered" } } : current);
        if (wasAttached && error && typeof error === "object") Object.defineProperty(error, "workflowResumeAttached", { value: true });
        throw error;
      }
    }
    if (!foreground && isForegroundAttached(runId)) await moveForegroundToBackground(runId);
    if (run.lifecycle.state === "budget_exhausted") {
      const result = await recovery.resumeWorkflowRun(runId, budgetPatch, context, undefined, foreground, foreground);
      return { workflowName: run.metadata.name, state: result.state === "completed" ? "completed" : result.state === "awaiting_approval" ? "awaiting_approval" : "running", attached: false, ...(result.state === "completed" && result.value !== undefined ? { value: result.value } : {}) };
    }
    if (run.lifecycle.state !== "interrupted") throw new WorkflowError("RESUME_INCOMPATIBLE", `Workflow run state changed: ${run.lifecycle.state}`);
    const completed = await recovery.coldResumeRun(run, hasUI, ui, projectTrusted(context), recoveryContext, foreground, foreground);
    return completed ? { workflowName: run.metadata.name, state: "completed", attached: false, value: completed.value } : { workflowName: run.metadata.name, state: "running", attached: false };
  };
  pi.registerTool({
    name: "workflow_retry",
    label: "Workflow Retry",
    description: "Retry a failed workflow run by replaying its completed structural operations",
    parameters: WORKFLOW_RETRY_PARAMETERS,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try { const result = await recovery.retryWorkflowRun(params.runId, ctx, signal, params.foreground, params.expectedState); return { content: [{ type: "text" as const, text: completionControlContent(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_retry", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_retry", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.registerTool({
    name: "workflow_resume",
    label: "Workflow Resume",
    description: "Resume an exhausted workflow with unchanged or patched aggregate budgets",
    parameters: Type.Object({ runId: Type.String(), expectedState: Type.Optional(Type.String({ description: "Persisted source state observed before recovery" })), budget: Type.Optional(Type.Unknown()), foreground: Type.Optional(Type.Boolean({ description: "Override the source launch mode for this recovery" })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try { const result = await recovery.resumeWorkflowRun(params.runId, params.budget, ctx, signal, params.foreground, true, params.expectedState); return { content: [{ type: "text" as const, text: completionControlContent(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_resume", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_resume", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (sessionStarted) return;
    sessionStarted = true;
    try {
    releaseWorkflowRegistry = retainWorkflowRegistry();
    registry.freeze();
    registerCatalog(ctx.cwd, projectTrusted(ctx));
    await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
    for (const runId of await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)) {
      if (runs.has(runId)) continue;
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
      try { loaded = await store.load(); } catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); continue; }
      if (loaded.run.state === "completed" || loaded.run.state === "failed" || loaded.run.state === "stopped") { terminalRunStates.set(runId, loaded.run.state); continue; }
      if (loaded.run.state !== "interrupted" && loaded.run.state !== "budget_exhausted") {
        const previousState = loaded.run.state;
        await store.updateState((current) => {
          if (["completed", "failed", "stopped", "interrupted", "budget_exhausted"].includes(current.state)) return current;
          const next = { ...current, state: "interrupted" as const };
          delete next.activeShells;
          delete next.activeShellStartedAt;
          delete next.activeShellsByPhase;
          return next;
        });
        loaded = { ...loaded, run: (await store.load()).run };
        await eventPublisher.runState(store, loaded.snapshot.metadata, previousState, "interrupted", "session_shutdown");
        loaded = { ...loaded, run: (await store.load()).run };
      } else if (loaded.run.activeShells !== undefined || loaded.run.activeShellStartedAt !== undefined || loaded.run.activeShellsByPhase !== undefined) {
        await store.updateState((current) => {
          if (["completed", "failed", "stopped"].includes(current.state)) return current;
          const next = { ...current };
          delete next.activeShells;
          delete next.activeShellStartedAt;
          delete next.activeShellsByPhase;
          return next;
        });
        loaded = { ...loaded, run: (await store.load()).run };
      }
      const model = modelSpec(loaded.snapshot.models[0] ?? "", { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", thinking: pi.getThinkingLevel() });
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      eventPublisher.seedBudget(runId, loaded.run.budgetEvents);
      const budgetRuntime = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents, { active: loaded.run.state === "running" });
      const lifecycle = lifecycleFor(store, loaded.run.state, budgetRuntime, loaded.snapshot.metadata);
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const roleDefinitions = loaded.snapshot.roles ?? {};
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(ctx, new Set(loaded.snapshot.models), () => { abortController.abort(); });
      runs.set(runId, { executor: createAgentExecutor({ cwd: ctx.cwd, model, tools: activeSnapshotTools(loaded.snapshot.tools, "session"), availableModels: new Set(loaded.snapshot.models), knownModels: new Set(loaded.snapshot.models), ...(loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ? { modelAliases: loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases } : {}), ...(loaded.snapshot.settingsSources?.modelAliases ? { settingsPath: loaded.snapshot.settingsSources.modelAliases } : loaded.snapshot.settingsPath ? { settingsPath: loaded.snapshot.settingsPath } : {}), agentDefinitions: roleDefinitions, runStore: store, providerPause, agentResourcePolicy: frozenResourcePolicy(snapshotResourcePolicy(loaded.snapshot, store.cwd, projectTrusted(ctx), workflowSettingsPath(extensionAgentDir))) }), store, metadata: loaded.snapshot.metadata, model, lifecycle, budget: budgetRuntime, abortController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) });
      for (const checkpoint of await store.awaitingCheckpoints()) deliver(pi, `Workflow ${loaded.snapshot.metadata.name} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
      for (const decision of await store.pendingWorkflowDecisions()) deliver(pi, recovery.budgetDecisionDelivery(loaded.snapshot.metadata, decision));
      scheduler.restoreRun(runId, loaded.snapshot.settings.concurrency, loaded.snapshot.identityVersion === LAUNCH_SNAPSHOT_IDENTITY_VERSION ? await store.loadOwnership() : [], () => runs.get(runId)?.budget.checkAgentLaunch());
    }
    const resumeSelect = uiHostCapabilities(ctx.ui)?.select;
    if (ctx.hasUI && resumeSelect) {
      const interrupted = [...runs.values()].filter((r) => r.lifecycle.state === "interrupted");
      if (interrupted.length > 0) {
        const labels = interrupted.map((r) => `Resume: ${r.metadata.name} (${r.store.runId.slice(0, 8)})`);
        const options = [...labels, ...(interrupted.length > 1 ? ["Resume all"] : []), "Skip"];
        const choice = await resumeSelect(`${String(interrupted.length)} interrupted workflow${interrupted.length > 1 ? "s" : ""} found`, options);
        if (choice && choice !== "Skip") {
          const toResume = choice === "Resume all" ? interrupted : interrupted.filter((_, i) => labels[i] === choice);
          await Promise.all(toResume.map(async (run) => {
            try { await recovery.coldResumeRun(run, true, ctx.ui, projectTrusted(ctx), resumeHostContext(ctx), undefined, false); ctx.ui.notify(`Resumed workflow ${run.metadata.name}.`, "info"); }
            catch (err) { ctx.ui.notify(`Cannot resume ${run.metadata.name}: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
          }));
        }
      }
    }
    } catch (error) {
      try { await releaseSessionLease(); } finally {
        if (releaseWorkflowRegistry) {
          releaseWorkflowRegistry();
          releaseWorkflowRegistry = undefined;
        }
      }
      throw error;
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const roles = Object.entries(loadAgentDefinitions(ctx.cwd, extensionAgentDir, projectTrusted(ctx), typeof registry.roleDirectoryRegistrations === "function" ? registry.roleDirectoryRegistrations() : undefined)).filter(([, definition]) => definition.description);
    if (!roles.length) return;
    const content = `Workflow role descriptions:\n${roles.map(([name, definition]) => `- \`${name}\`: ${String(definition.description)}`).join("\n")}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });
  const workflowTool: ToolDefinition<typeof WORKFLOW_TOOL_PARAMETERS, WorkflowToolResult, WorkflowProgressRenderState> = {
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
      const headless = object(ctx) && ctx.headless === true;
      const settingsPath = workflowSettingsPath(extensionAgentDir);
      if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
      const budget = validateBudget(params.budget);
      const rootModel: ModelSpec = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const rootModelName = `${rootModel.provider}/${rootModel.model}`;
      const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
      const inventory = modelInventory(rootModel, modelRegistry);
      const knownModels = inventory.knownModels;
      const availableModels = inventory.availableModels;
      const rootTools = pi.getActiveTools().filter((name) => !INTERNAL_WORKFLOW_TOOLS.includes(name));
      const trustedProject = projectTrusted(ctx);
      const launchCwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
      const launch = workflowLaunchSettings(launchCwd, trustedProject, settingsPath, params.concurrency);
      const runController = new AbortController();
      let foregroundAttached = Boolean(params.foreground);
      const onForegroundAbort = () => { runController.abort(); };
      if (signal?.aborted) runController.abort(); else signal?.addEventListener("abort", onForegroundAbort, { once: true });
      let resolveDetached: ((result: ForegroundDetachResult) => void) | undefined;
      const detachedResult = params.foreground ? new Promise<ForegroundDetachResult>((resolve) => { resolveDetached = resolve; }) : undefined;
      const resolvedAliases = await resolveLaunchAliases(registry, launch.settings.modelAliases ?? {}, { cwd: launchCwd, projectTrusted: trustedProject, rootModel, knownModels, availableModels, signal: runController.signal }, availableModels, knownModels, settingsPath);
      const modelAliases = resolvedAliases.aliases;
      const settings = Object.freeze({ ...launch.settings, ...(Object.keys(modelAliases).length ? { modelAliases } : {}) });
      const validated = validateWorkflowLaunchWithRegistry(params, { cwd: ctx.cwd, agentDir: extensionAgentDir, projectTrusted: trustedProject, availableModels, rootTools: new Set(rootTools), modelAliases, knownModels, settingsPath }, registry);
      const { script, checked, agentDefinitions, projectAgentDefinitions, roleNames } = validated;
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const runId = randomUUID();
      const args = params.args ?? null;
      encoded(args);
      const runContext = workflowRunContext(ctx.cwd, ctx.sessionManager.getSessionId(), runId, checked.metadata, args, runController.signal);
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const parentRunId = params.parentRunId;
      if (parentRunId !== undefined) await store.validateParentRun(parentRunId);
      const roles = Object.fromEntries(roleNames.map((role) => [role, agentDefinitions[role]])) as Record<string, AgentDefinition>;
      const projectRoles = roleNames.filter((role) => projectAgentDefinitions[role] !== undefined);
      const roleModels = roleNames.flatMap((role) => { const model = agentDefinitions[role]?.model; return model ? [modelCapability(model, modelAliases, knownModels, settingsPath)] : []; });
      const snapshotModels = [...new Set([rootModelName, ...checked.referenced.models, ...roleModels])];
      const snapshot = createLaunchSnapshot({ script, args, metadata: checked.metadata, launchMode: params.foreground ? "foreground" : "background", settings, settingsPath, settingsSources: { ...launch.resolution.sources, concurrency: params.concurrency === undefined ? launch.resolution.sources.concurrency : "per-run options" }, ...(Object.keys(modelAliases).length ? { modelAliases } : {}), ...(budget ? { budget } : {}), ...(checked.referenced.phases.length ? { phases: checked.referenced.phases } : {}), models: snapshotModels, tools: rootTools, agentTypes: checked.referenced.agentTypes, roles, projectRoles, schemas: checked.schemas });
      let persistedSnapshot = snapshot;
      const captureRole = async (role: string, model: ModelSpec): Promise<void> => {
        const definition = agentDefinitions[role];
        if (!definition) return;
        const modelName = `${model.provider}/${model.model}`;
        const hasProjectRole = projectAgentDefinitions[role] !== undefined;
        if (persistedSnapshot.roles?.[role] !== undefined && (!hasProjectRole || persistedSnapshot.projectRoles?.includes(role)) && persistedSnapshot.models.includes(modelName)) return;
        const roles = { ...(persistedSnapshot.roles ?? {}), [role]: definition };
        const projectRoles = hasProjectRole ? [...new Set([...(persistedSnapshot.projectRoles ?? []), role])] : persistedSnapshot.projectRoles ?? [];
        const models = [...new Set([...persistedSnapshot.models, modelName])];
        persistedSnapshot = createLaunchSnapshot({ ...persistedSnapshot, models, roles, projectRoles });
        await store.saveSnapshot(persistedSnapshot);
      };
      const budgetRuntime = new WorkflowBudgetRuntime(budget);
      const initialBudget = budgetRuntime.snapshot();
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", ...(parentRunId !== undefined ? { parentRunId } : {}), agents: [], agentSessions: [], delivery: params.foreground ? { mode: "foreground", state: "attached", toolCallId } : { mode: "background", state: "pending" }, ...(budget ? { budget } : {}), budgetVersion: 1, ...initialBudget }, snapshot);
      if (params.foreground) {
        const delivery: ForegroundDelivery = {
          store, inline: false, detached: false,
          detach: async () => {
            let moved: boolean | undefined;
            await store.updateState((current) => {
              if (["completed", "failed", "stopped"].includes(current.state) || current.delivery?.mode !== "foreground" || current.delivery.state !== "attached") return current;
              moved = true;
              return { ...current, delivery: { mode: "background", state: "pending" } };
            });
            if (moved !== true) throw new WorkflowError("RESUME_INCOMPATIBLE", `Workflow ${runId} is no longer an attached foreground run`);
            foregroundAttached = false;
            delivery.detached = true;
            const activeRun = runs.get(runId);
            if (activeRun) { activeRun.foreground = false; delete activeRun.update; }
            await store.saveSnapshot(createLaunchSnapshot({ ...persistedSnapshot, launchMode: "background" }));
            for (const checkpoint of await store.awaitingCheckpoints()) deliverBackgroundCheckpoint(checked.metadata.name, runId, checkpoint);
            signal?.removeEventListener("abort", onForegroundAbort);
            if (delivery.timer) clearTimeout(delivery.timer);
            const run = (await store.load()).run;
            const result = { runId, state: "running" as const, detached: true as const, run };
            resolveDetached?.(result);
            return result;
          },
        };
        foregroundDeliveries.set(toolCallId, delivery);
      }
      const lifecycle = lifecycleFor(store, "running", budgetRuntime, checked.metadata);
      const backgroundLaunch = !params.foreground;
      const providerPause = async () => { if (!foregroundAttached) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const providerErrorRecovery = createProviderErrorRecovery(ctx, availableModels, () => { runController.abort(); });
      const executor = createAgentExecutor({ cwd: ctx.cwd, model: rootModel, tools: new Set(rootTools), availableModels, knownModels, modelAliases, settingsPath, agentDefinitions, runStore: store, providerPause, agentResourcePolicy: frozenResourcePolicy(launch.resourcePolicy), runContext });
      runs.set(runId, { executor, store, metadata: checked.metadata, model: rootModel, lifecycle, budget: budgetRuntime, abortController: runController, foreground: foregroundAttached, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) });
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, () => runs.get(runId)?.budget.checkAgentLaunch());
      const execution = runWorkflow(script, args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(store, checked.metadata, lifecycle, command, options, signal, identity), agent: workflowAgentHandler(store, checked.metadata, lifecycle, executor, ctx.cwd, runId, captureRole), worktree: async (owner) => resolveWorktree(store, checked.metadata, owner), checkpoint: checkpointBridge(runId, store, checked.metadata, () => runs.get(runId)?.foreground ?? foregroundAttached, ctx.hasUI ? ctx.ui : undefined, headless), phase: phaseBridge(store, checked.metadata, lifecycle), log: logBridge(store, lifecycle, checked.metadata.name) }, store, runContext, registry), runController.signal);
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).execution = execution;
      await eventPublisher.runStarted(store, checked.metadata);
      const finish = execution.result.then(async (value) => {
        await scheduler.flush();
        if (budgetRuntime.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
        const resultPath = await store.saveResult(value);
        const resultBytes = await store.resultBytes();
        await lifecycle.terminal("completed", "completed");
        await eventPublisher.runCompleted(store, checked.metadata, resultPath);
        return { value, resultPath, resultBytes };
      }).catch(async (error: unknown) => {
        await scheduler.flush();
        const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error));
        if (!["stopped", "interrupted", "budget_exhausted"].includes(lifecycle.state)) await lifecycle.terminal(typed.code === "CANCELLED" ? "stopped" : typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
        const persisted = await persistRunState(store, checked.metadata, (current) => persistedFailure({ ...current, ...budgetRuntime.snapshot() }, typed));
        const state = lifecycle.state === "stopped" || lifecycle.state === "interrupted" || lifecycle.state === "budget_exhausted" ? lifecycle.state : "failed";
        await eventPublisher.runFailed(store, checked.metadata, typed, state);
        const diagnostic = await createWorkflowFailureDiagnostics(store, checked.metadata, typed, persisted);
        markWorkflowFailureDiagnostics(typed, diagnostic);
        if (params.foreground) pendingFailureDiagnostics.set(toolCallId, { diagnostic, run: persisted });
        throw typed;
      });
      const completion = finish.finally(() => cleanupTerminalRun(runId));
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).completion = completion;
      const deliverFailureContent = (error: unknown): string => {
        const diagnostic = failureDiagnosticsFrom(error);
        return diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(checked.metadata.name, runId, store.directory, error);
      };
      type Completion = { value: JsonValue; resultPath: string; resultBytes: number };
      const completionContent = (mode: "foreground" | "background", result: Completion): (() => Promise<string>) => async () => (await completionDeliveryFromStore({ mode, name: checked.metadata.name, runId, value: result.value, resultPath: result.resultPath, resultBytes: result.resultBytes, store, context: completionContext(ctx) })).content;
      const queueForegroundDelivery = async (content: string | (() => string | Promise<string>), failure = false): Promise<void> => {
        const delivery = foregroundDeliveries.get(toolCallId);
        if (!delivery) return;
        if (delivery.detached) {
          pendingFailureDiagnostics.delete(toolCallId);
          await deliverTerminal(store, content, failure);
          foregroundDeliveries.delete(toolCallId);
          return;
        }
        await store.updateState((current) => {
          if (!current.delivery || current.delivery.state === "delivered") return current;
          return { ...current, delivery: { ...current.delivery, mode: "background", state: "pending" } };
        });
        if (delivery.inline) return;
        scheduleForegroundDelivery(toolCallId, async () => {
          if (delivery.inline || delivery.detached) return;
          pendingFailureDiagnostics.delete(toolCallId);
          await deliverTerminal(store, content, failure);
        });
      };
      if (backgroundLaunch) {
        void completion.then(async (result) => {
          await deliverTerminal(store, completionContent("background", result));
        }, async (error: unknown) => {
          await deliverTerminal(store, deliverFailureContent(error), true);
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, preview: `Started workflow ${runId}.` } };
      }
      void completion.then(async (result) => {
        await queueForegroundDelivery(completionContent("background", result));
      }, async (error: unknown) => {
        await queueForegroundDelivery(deliverFailureContent(error), true);
      });
      const outcome = detachedResult === undefined
        ? { kind: "completed" as const, result: await completion }
        : await Promise.race([
          completion.then((result) => ({ kind: "completed" as const, result })),
          detachedResult.then((result) => ({ kind: "detached" as const, result })),
        ]);
      if (outcome.kind === "detached") {
        const { run, ...detached } = outcome.result;
        return { content: [{ type: "text" as const, text: JSON.stringify(detached) }], details: { ...detached, run, preview: `Moved workflow ${runId} to background.` } };
      }
      const { value, resultPath, resultBytes } = outcome.result;
      const delivery = await completionDeliveryFromStore({ mode: "foreground", name: checked.metadata.name, runId, value, resultPath, resultBytes, store, context: completionContext(ctx) });
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: delivery.content }, ...(delivery.inlined ? [{ type: "text" as const, text: `Workflow run ID: ${runId}` }] : [])], details: { runId, value, run } };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args) {
      return textBlock(formatWorkflowPreview(args));
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      const details = result.details;
      if (isWorkflowFailureDiagnostics(details)) {
        const failureRun = object(details) && isPersistedRun(details.run) ? details.run : undefined;
        if (!failureRun) return textBlock(formatWorkflowFailureDiagnostics(details));
        const failure = workflowProgressBlock(failureRun, theme, undefined, undefined, undefined, formatWorkflowFailureDiagnostics(details));
        failure.setExpanded(expanded);
        return failure;
      }
      const runDetails = isWorkflowToolResult(details) ? details : undefined;
      const state = context.state;
      if (runDetails?.run && isPartial && runDetails.run.state === "running" && !state.workflowSpinner) {
        state.workflowSpinner = setInterval(context.invalidate, 80);
        state.workflowSpinner.unref();
      } else if ((!isPartial || runDetails?.run?.state !== "running") && state.workflowSpinner) {
        clearInterval(state.workflowSpinner);
        delete state.workflowSpinner;
      }
      if (runDetails?.run) {
        const incoming = runDetails.run;
        let progress = state.workflowProgress;
        if (!isPartial || !progress || progress.runId !== incoming.id) {
          progress = undefined;
          delete state.workflowProgress;
          delete state.workflowProgressComponent;
          if (isPartial) {
            progress = { runId: incoming.id, inputRun: incoming, run: incoming, lastRefreshAt: 0, runtimeStartedAt: Date.now(), runtimeBaseMs: incoming.usage?.durationMs ?? 0 };
            state.workflowProgress = progress;
          }
        } else if (progress.inputRun !== incoming) {
          if (progress.run.state !== "running" && incoming.state === "running") {
            progress.runtimeBaseMs = incoming.usage?.durationMs ?? 0;
            progress.runtimeStartedAt = Date.now();
          }
          progress.inputRun = incoming;
          progress.run = incoming;
        }
        if (!state.workflowProgressComponent) {
          const requestRender = context.invalidate;
          const currentProgress = progress;
          state.workflowProgressComponent = workflowProgressBlock(currentProgress?.run ?? incoming, theme, currentProgress, async () => {
            const active = runs.get(incoming.id);
            const store = active?.store ?? new RunStore(incoming.cwd, incoming.sessionId, incoming.id, home);
            const loaded = await store.load();
            return withLiveActivities(loaded.run);
          }, () => { if (state.workflowProgress === currentProgress) requestRender(); });
        }
        state.workflowProgressComponent.setExpanded(expanded);
        return state.workflowProgressComponent;
      }
      const content = result.content[0];
      return textBlock(isPartial ? "Workflow starting..." : runDetails?.preview ?? (content?.type === "text" ? content.text : "Workflow finished"));
    },
  };
  pi.registerTool(workflowTool);
  registerWorkflowNavigator({ pi, home, clipboard, extensionAgentDir, runs, terminalRunStates, hardTerminalRunStates: HARD_TERMINAL_RUN_STATES, ensureSessionLease, answerCheckpoint, recovery, stopWorkflowRun, moveForegroundToBackground, isForegroundAttached, withLiveActivities, liveAgentSessions, liveAgentPrepared, liveAgentHandoffs, registry, projectTrusted, resumeHostContext, resumeSelectedWorkflow });
  pi.on("session_shutdown", async () => {
    try {
      await Promise.all([...runs.entries()].map(async ([runId, run]) => {
        const isTerminal = SHUTDOWN_TERMINAL_RUN_STATES.has(run.lifecycle.state);
        if (!isTerminal) {
          try { await run.lifecycle.terminal("interrupted"); } catch (error) { if (!SHUTDOWN_TERMINAL_RUN_STATES.has(run.lifecycle.state)) throw error; }
          run.abortController.abort();
          run.execution?.cancel();
          await scheduler.cancelRun(runId);
        }
        await run.completion?.catch(() => undefined);
      }));
      await scheduler.flush();
    } finally {
      try { await releaseSessionLease(); } finally {
        if (releaseWorkflowRegistry) {
          releaseWorkflowRegistry();
          releaseWorkflowRegistry = undefined;
        } else {
          resetWorkflowRegistryIfIdle();
        }
      }
    }
  });
}

function displayAgentName(label: string | undefined, role: string | undefined, model: ModelSpec): string {
  return label ?? role ?? model.model;
}

function modelSpec(value: string, fallback: ModelSpec): ModelSpec {
  try {
    const parsed = parseModelReference(value);
    return { ...parsed, ...(parsed.thinking || !fallback.thinking ? {} : { thinking: fallback.thinking }) };
  } catch {
    return fallback;
  }
}



