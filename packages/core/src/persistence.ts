import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { AGENT_STATES, ERROR_CODES, RUN_STATES, WorkflowError, type AgentAccounting, type AgentActivity, type AgentAttemptSummary, type AgentDefinition, type AgentRecord, type AgentResourceExclusions, type BudgetApprovalRequest, type BudgetDimension, type BudgetEvent, type ContextFileScope, type JsonValue, type LaunchSnapshot, type ModelSpec, type RoleOverride, type RunRecord, type WorkflowBudgetUsage, type WorkflowRunEvent } from "./types.js";
import type { OwnershipRecord, ScheduledAgentOptions } from "./agent-execution.js";
import { isNodeError, jsonValue, loadLaunchSnapshot, object } from "./utils.js";

export interface EffectiveSystemPrompt { sessionId: string; attempt: number; turn: number; sha256: string; prompt: string }
export type PersistedRun = RunRecord;
type LoadedPersistedRun = PersistedRun;
export interface RunSummaryAgent { id: string; name: string; label?: string; state: string; role?: string; attempts: number }
export interface RunSummaryArtifacts { runDirectory: string; statePath: string; journalPath: string; snapshotPath: string; workflowPath: string; resultPath: string; summaryPath: string }
export interface RunSummary { schemaVersion: 1; runId: string; sessionId: string; workflowName: string; state: RunRecord["state"]; createdAt: string; updatedAt: string; terminalAt?: string; usage: WorkflowBudgetUsage; agents: readonly RunSummaryAgent[]; error?: RunRecord["error"]; failedAt?: string; replayablePaths: readonly string[]; incompletePaths: readonly string[]; artifacts: RunSummaryArtifacts }
export interface CompletedOperation { path: string; value: JsonValue }
export interface AwaitingCheckpoint { path: string; name: string; prompt: string; context: JsonValue }
export type PendingWorkflowDecision = BudgetApprovalRequest
export type PersistedOwnershipNode = OwnershipRecord
type Journal = { completed: Record<string, CompletedOperation>; awaiting?: Record<string, AwaitingCheckpoint>; decisions?: Record<string, PendingWorkflowDecision> };
type PersistedAgentSession = RunRecord["agentSessions"][number];
type PersistedAgent = RunRecord["agents"][number];
type PersistedPhaseRecord = NonNullable<RunRecord["phaseHistory"]>[number];
type PersistedShellActivity = NonNullable<RunRecord["activeShellsByPhase"]>[number];
type PersistedDelivery = NonNullable<RunRecord["delivery"]>;
type PersistedRoleOverride = Exclude<NonNullable<ScheduledAgentOptions["role"]>, string>;
type PersistedIdentity = NonNullable<ScheduledAgentOptions["agentIdentity"]>;
type PersistedOptions = ScheduledAgentOptions;

const INVALID_PERSISTED_VALUE = Symbol("invalid persisted value");

function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function integer(value: unknown): value is number { return finiteNumber(value) && Number.isInteger(value); }
function positiveInteger(value: unknown): value is number { return integer(value) && value > 0; }
function isThinking(value: unknown): value is NonNullable<ScheduledAgentOptions["thinking"]> { return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].some((candidate) => candidate === value); }
function isContextFileScope(value: unknown): value is ContextFileScope { return ["global", "project", "cwd"].some((candidate) => candidate === value); }
function isLaunchMode(value: unknown): value is NonNullable<LaunchSnapshot["launchMode"]> { return value === "foreground" || value === "background"; }
function isRunState(value: unknown): value is RunRecord["state"] { return RUN_STATES.some((candidate) => candidate === value); }
function isAgentState(value: unknown): value is PersistedAgent["state"] { return AGENT_STATES.some((candidate) => candidate === value); }
function isOwnershipState(value: unknown): value is OwnershipRecord["state"] { return ["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"].some((candidate) => candidate === value); }
function isBudgetDimension(value: unknown): value is BudgetDimension { return ["tokens", "costUsd", "durationMs", "agentLaunches"].some((candidate) => candidate === value); }
function isBudgetEventType(value: unknown): value is NonNullable<RunRecord["budgetEvents"]>[number]["type"] { return ["soft_crossed", "hard_overrun", "hard_exhausted", "adjustment_requested", "adjustment_approved", "adjustment_rejected"].some((candidate) => candidate === value); }
function isWorkflowErrorCode(value: unknown): value is NonNullable<RunRecord["error"]>["code"] { return ERROR_CODES.some((candidate) => candidate === value); }
function optionalString(value: unknown): string | undefined | typeof INVALID_PERSISTED_VALUE { return value === undefined || typeof value === "string" ? value : INVALID_PERSISTED_VALUE; }
function optionalNumber(value: unknown): number | undefined | typeof INVALID_PERSISTED_VALUE { return value === undefined || finiteNumber(value) ? value : INVALID_PERSISTED_VALUE; }
function optionalBoolean(value: unknown): boolean | undefined | typeof INVALID_PERSISTED_VALUE { return value === undefined || typeof value === "boolean" ? value : INVALID_PERSISTED_VALUE; }
function decodeArray<T>(value: unknown, decoder: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: T[] = [];
  for (const entry of value) {
    const result = decoder(entry);
    if (result === undefined) return undefined;
    decoded.push(result);
  }
  return decoded;
}
function decodeStringArray(value: unknown): string[] | undefined { return decodeArray(value, (entry) => typeof entry === "string" ? entry : undefined); }
function decodeJsonValue(value: unknown): JsonValue | undefined { return jsonValue(value) ? value : undefined; }
function decodeJsonObject(value: unknown): Record<string, JsonValue> | undefined {
  if (!object(value) || !jsonValue(value)) return undefined;
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!jsonValue(entry)) return undefined;
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}
function decodeStringMap(value: unknown): Record<string, string> | undefined {
  if (!object(value)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}
function decodeRecord<T>(value: unknown, decoder: (value: unknown) => T | undefined): Record<string, T> | undefined {
  if (!object(value)) return undefined;
  const entries: Array<[string, T]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const decoded = decoder(entry);
    if (decoded === undefined) return undefined;
    entries.push([key, decoded]);
  }
  return Object.fromEntries(entries);
}

function decodeModelSpec(value: unknown): ModelSpec | undefined {
  if (!object(value) || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
  const thinking = value.thinking;
  if (thinking !== undefined && !isThinking(thinking)) return undefined;
  return { provider: value.provider, model: value.model, ...(thinking === undefined ? {} : { thinking }) };
}
function decodeAgentResourceExclusions(value: unknown): AgentResourceExclusions | undefined {
  if (!object(value)) return undefined;
  const skills = decodeStringArray(value.skills);
  const extensions = decodeStringArray(value.extensions);
  if (!skills || !extensions) return undefined;
  return { skills, extensions };
}
function decodeContextFileScopes(value: unknown): ContextFileScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes: ContextFileScope[] = [];
  for (const scope of value) {
    if (!isContextFileScope(scope)) return undefined;
    scopes.push(scope);
  }
  return scopes;
}
function decodeRoleOverride(value: unknown): RoleOverride | undefined {
  if (!object(value) || typeof value.name !== "string") return undefined;
  const model = value.model;
  const thinking = value.thinking;
  const tools = value.tools;
  const description = value.description;
  const overrideSystemPrompt = value.overrideSystemPrompt;
  const contextFiles = value.contextFiles;
  const disabledAgentResources = value.disabledAgentResources;
  if (model !== undefined && model !== null && typeof model !== "string") return undefined;
  if (thinking !== undefined && thinking !== null && !isThinking(thinking)) return undefined;
  if (description !== undefined && description !== null && typeof description !== "string") return undefined;
  if (overrideSystemPrompt !== undefined && overrideSystemPrompt !== null && typeof overrideSystemPrompt !== "boolean") return undefined;
  const decodedTools = tools === undefined ? undefined : tools === null ? null : decodeStringArray(tools);
  const decodedContextFiles = contextFiles === undefined ? undefined : contextFiles === null ? null : decodeContextFileScopes(contextFiles);
  const decodedResources = disabledAgentResources === undefined ? undefined : disabledAgentResources === null ? null : decodeAgentResourceExclusions(disabledAgentResources);
  const result: RoleOverride = { name: value.name };
  if (model !== undefined) result.model = model;
  if (thinking !== undefined) result.thinking = thinking;
  if (tools !== undefined) {
    if (decodedTools === undefined) return undefined;
    result.tools = decodedTools;
  }
  if (description !== undefined) result.description = description;
  if (overrideSystemPrompt !== undefined) result.overrideSystemPrompt = overrideSystemPrompt;
  if (contextFiles !== undefined) {
    if (decodedContextFiles === undefined) return undefined;
    result.contextFiles = decodedContextFiles;
  }
  if (disabledAgentResources !== undefined) {
    if (decodedResources === undefined) return undefined;
    result.disabledAgentResources = decodedResources === null ? null : { skills: [...decodedResources.skills], extensions: [...decodedResources.extensions] };
  }
  return result;
}
function decodeAgentDefinition(value: unknown): AgentDefinition | undefined {
  if (!object(value)) return undefined;
  const prompt = optionalString(value.prompt);
  const description = optionalString(value.description);
  const model = optionalString(value.model);
  const thinking = value.thinking;
  const tools = value.tools === undefined ? undefined : decodeStringArray(value.tools);
  const overrideSystemPrompt = optionalBoolean(value.overrideSystemPrompt);
  const contextFiles = value.contextFiles === undefined ? undefined : decodeContextFileScopes(value.contextFiles);
  const disabledAgentResources = value.disabledAgentResources === undefined ? undefined : decodeAgentResourceExclusions(value.disabledAgentResources);
  if (prompt === INVALID_PERSISTED_VALUE || description === INVALID_PERSISTED_VALUE || model === INVALID_PERSISTED_VALUE || overrideSystemPrompt === INVALID_PERSISTED_VALUE) return undefined;
  if (thinking !== undefined && !isThinking(thinking) || value.tools !== undefined && !tools || value.contextFiles !== undefined && !contextFiles || value.disabledAgentResources !== undefined && !disabledAgentResources) return undefined;
  return {
    ...(prompt === undefined ? {} : { prompt }),
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
    ...(overrideSystemPrompt === undefined ? {} : { overrideSystemPrompt }),
    ...(contextFiles === undefined ? {} : { contextFiles }),
    ...(disabledAgentResources === undefined ? {} : { disabledAgentResources }),
  };
}
function decodeWorkflowMetadata(value: unknown): LaunchSnapshot["metadata"] | undefined {
  if (!object(value) || typeof value.name !== "string") return undefined;
  const description = optionalString(value.description);
  if (description === INVALID_PERSISTED_VALUE) return undefined;
  return { name: value.name, ...(description === undefined ? {} : { description }) };
}
function decodeWorkflowExtensions(value: unknown): NonNullable<LaunchSnapshot["settings"]["extensions"]> | undefined {
  if (!object(value)) return undefined;
  if (value.herdr === undefined) return {};
  if (!object(value.herdr)) return undefined;
  const enableFullyInspectableMode = optionalBoolean(value.herdr.enableFullyInspectableMode);
  if (enableFullyInspectableMode === INVALID_PERSISTED_VALUE) return undefined;
  return { herdr: { ...(enableFullyInspectableMode === undefined ? {} : { enableFullyInspectableMode }) } };
}
function decodeBudgetLimits(value: unknown): NonNullable<NonNullable<RunRecord["budget"]>[BudgetDimension]> | undefined {
  if (!object(value)) return undefined;
  const soft = optionalNumber(value.soft);
  const hard = optionalNumber(value.hard);
  if (soft === INVALID_PERSISTED_VALUE || hard === INVALID_PERSISTED_VALUE) return undefined;
  return { ...(soft === undefined ? {} : { soft }), ...(hard === undefined ? {} : { hard }) };
}
function decodeBudget(value: unknown): NonNullable<RunRecord["budget"]> | undefined {
  if (!object(value)) return undefined;
  const budget: NonNullable<RunRecord["budget"]> = {};
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) {
    const raw = value[dimension];
    if (raw === undefined) continue;
    const limits = decodeBudgetLimits(raw);
    if (limits === undefined) return undefined;
    budget[dimension] = limits;
  }
  return budget;
}
function decodeWorkflowSettings(value: unknown): LaunchSnapshot["settings"] | undefined {
  if (!object(value) || !positiveInteger(value.concurrency)) return undefined;
  const modelAliases = value.modelAliases === undefined ? undefined : decodeStringMap(value.modelAliases);
  const disabledAgentResources = value.disabledAgentResources === undefined ? undefined : decodeAgentResourceExclusions(value.disabledAgentResources);
  const extensions = value.extensions === undefined ? undefined : decodeWorkflowExtensions(value.extensions);
  if ((value.modelAliases !== undefined && !modelAliases) || (value.disabledAgentResources !== undefined && !disabledAgentResources) || (value.extensions !== undefined && !extensions)) return undefined;
  return {
    concurrency: value.concurrency,
    ...(modelAliases === undefined ? {} : { modelAliases }),
    ...(disabledAgentResources === undefined ? {} : { disabledAgentResources }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}
function decodeWorkflowSettingsSources(value: unknown): NonNullable<LaunchSnapshot["settingsSources"]> | undefined {
  if (!object(value) || typeof value.concurrency !== "string" || typeof value.modelAliases !== "string" || typeof value.disabledAgentResources !== "string") return undefined;
  return { concurrency: value.concurrency, modelAliases: value.modelAliases, disabledAgentResources: value.disabledAgentResources };
}
function decodeIdentity(value: unknown): PersistedIdentity | undefined {
  if (!object(value) || typeof value.callSite !== "string" || !positiveInteger(value.occurrence)) return undefined;
  const structuralPath = decodeStringArray(value.structuralPath);
  const parentBreadcrumb = optionalString(value.parentBreadcrumb);
  const worktreeOwner = optionalString(value.worktreeOwner);
  if (!structuralPath || parentBreadcrumb === INVALID_PERSISTED_VALUE || worktreeOwner === INVALID_PERSISTED_VALUE) return undefined;
  return { structuralPath, callSite: value.callSite, occurrence: value.occurrence, ...(parentBreadcrumb === undefined ? {} : { parentBreadcrumb }), ...(worktreeOwner === undefined ? {} : { worktreeOwner }) };
}
function decodeScheduledAgentOptions(value: unknown): PersistedOptions | undefined {
  if (!object(value) || typeof value.label !== "string" || typeof value.cwd !== "string") return undefined;
  const tools = decodeStringArray(value.tools);
  if (!tools) return undefined;
  const requestedLabel = optionalString(value.requestedLabel);
  const parentBreadcrumb = optionalString(value.parentBreadcrumb);
  const worktreeOwner = optionalString(value.worktreeOwner);
  const model = optionalString(value.model);
  const thinking = value.thinking;
  const role = value.role;
  const schema = value.schema === undefined ? undefined : decodeJsonObject(value.schema);
  const retries = optionalNumber(value.retries);
  const timeoutMs = value.timeoutMs;
  const agentOptions = value.agentOptions === undefined ? undefined : decodeJsonObject(value.agentOptions);
  const agentIdentity = value.agentIdentity === undefined ? undefined : decodeIdentity(value.agentIdentity);
  let decodedRole: string | PersistedRoleOverride | undefined;
  if (role !== undefined) {
    if (typeof role === "string") decodedRole = role;
    else decodedRole = decodeRoleOverride(role);
  }
  if (requestedLabel === INVALID_PERSISTED_VALUE || parentBreadcrumb === INVALID_PERSISTED_VALUE || worktreeOwner === INVALID_PERSISTED_VALUE || model === INVALID_PERSISTED_VALUE || (thinking !== undefined && !isThinking(thinking)) || (role !== undefined && decodedRole === undefined) || (value.schema !== undefined && !schema) || retries === INVALID_PERSISTED_VALUE || (retries !== undefined && !integer(retries)) || (timeoutMs !== undefined && timeoutMs !== null && !finiteNumber(timeoutMs)) || (value.agentOptions !== undefined && !agentOptions) || (value.agentIdentity !== undefined && !agentIdentity)) return undefined;
  return {
    label: value.label,
    ...(requestedLabel === undefined ? {} : { requestedLabel }),
    ...(parentBreadcrumb === undefined ? {} : { parentBreadcrumb }),
    cwd: value.cwd,
    tools,
    ...(worktreeOwner === undefined ? {} : { worktreeOwner }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(decodedRole === undefined ? {} : { role: decodedRole }),
    ...(schema === undefined ? {} : { schema }),
    ...(retries === undefined ? {} : { retries }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(agentIdentity === undefined ? {} : { agentIdentity }),
  };
}
function decodeAgentSession(value: unknown): PersistedAgentSession | undefined {
  if (!object(value) || typeof value.transport !== "string" || typeof value.sessionId !== "string") return undefined;
  const locator = value.locator === undefined ? undefined : decodeJsonValue(value.locator);
  if (value.locator !== undefined && locator === undefined) return undefined;
  return { transport: value.transport, sessionId: value.sessionId, ...(locator === undefined ? {} : { locator }) };
}
function decodeAgentAccounting(value: unknown): AgentAccounting | undefined {
  if (!object(value) || !finiteNumber(value.input) || !finiteNumber(value.output) || !finiteNumber(value.cacheRead) || !finiteNumber(value.cacheWrite) || !finiteNumber(value.cost)) return undefined;
  return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, cost: value.cost };
}
function decodeAgentActivity(value: unknown): AgentActivity | undefined {
  if (!object(value) || typeof value.text !== "string") return undefined;
  const kind = value.kind;
  if (kind !== "reasoning" && kind !== "tool" && kind !== "text") return undefined;
  return { kind, text: value.text };
}
function decodeAgentToolCall(value: unknown): NonNullable<AgentRecord["toolCalls"]>[number] | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const state = value.state;
  if (state !== "running" && state !== "completed" && state !== "failed") return undefined;
  return { id: value.id, name: value.name, state };
}
function decodeAgentSetupSummary(value: unknown): NonNullable<NonNullable<AgentRecord["attemptDetails"]>[number]["setup"]> | undefined {
  if (!object(value) || typeof value.cwd !== "string") return undefined;
  const hookNames = decodeStringArray(value.hookNames);
  const tools = decodeStringArray(value.tools);
  const model = decodeModelSpec(value.model);
  const resources = value.disabledAgentResources;
  let disabledAgentResources: NonNullable<AgentAttemptSummary["setup"]["disabledAgentResources"]> | undefined;
  if (resources !== undefined) {
    if (!object(resources)) return undefined;
    const base = decodeAgentResourceExclusions(resources);
    const unmatchedSkills = decodeStringArray(resources.unmatchedSkills);
    const unmatchedExtensions = decodeStringArray(resources.unmatchedExtensions);
    const excludedSkills = resources.excludedSkills === undefined ? undefined : decodeStringArray(resources.excludedSkills);
    const excludedExtensions = resources.excludedExtensions === undefined ? undefined : decodeStringArray(resources.excludedExtensions);
    if (!base || !unmatchedSkills || !unmatchedExtensions || resources.excludedSkills !== undefined && !excludedSkills || resources.excludedExtensions !== undefined && !excludedExtensions) return undefined;
    disabledAgentResources = { ...base, unmatchedSkills, unmatchedExtensions, ...(excludedSkills === undefined ? {} : { excludedSkills }), ...(excludedExtensions === undefined ? {} : { excludedExtensions }) };
  }
  if (!hookNames || !tools || !model) return undefined;
  return { hookNames, model, tools, cwd: value.cwd, ...(disabledAgentResources === undefined ? {} : { disabledAgentResources }) };
}
function decodeAttemptError(value: unknown): NonNullable<NonNullable<AgentRecord["attemptDetails"]>[number]["error"]> | undefined {
  if (!object(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return { code: value.code, message: value.message };
}
function decodeAgentAttempt(value: unknown): AgentAttemptSummary | undefined {
  if (!object(value) || !positiveInteger(value.attempt) || typeof value.transport !== "string") return undefined;
  const session = value.session === undefined ? undefined : decodeAgentSession(value.session);
  const setup = decodeAgentSetupSummary(value.setup);
  const error = value.error === undefined ? undefined : decodeAttemptError(value.error);
  const accounting = decodeAgentAccounting(value.accounting);
  if (!setup || !accounting || value.session !== undefined && !session || value.error !== undefined && !error) return undefined;
  return { attempt: value.attempt, transport: value.transport, setup, accounting, ...(session === undefined ? {} : { session }), ...(error === undefined ? {} : { error }) };
}
function decodeAgent(value: unknown): AgentRecord | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.path !== "string" || !isAgentState(value.state) || !integer(value.attempts)) return undefined;
  const model = decodeModelSpec(value.model);
  const tools = decodeStringArray(value.tools);
  const systemPrompt = optionalString(value.systemPrompt);
  const prompt = optionalString(value.prompt);
  const label = optionalString(value.label);
  const parentId = optionalString(value.parentId);
  const structuralPath = value.structuralPath === undefined ? undefined : decodeStringArray(value.structuralPath);
  const resultPath = optionalString(value.resultPath);
  const parentBreadcrumb = optionalString(value.parentBreadcrumb);
  const worktreeOwner = optionalString(value.worktreeOwner);
  const role = optionalString(value.role);
  const requestedModel = optionalString(value.requestedModel);
  const startedAt = optionalNumber(value.startedAt);
  const durationMs = optionalNumber(value.durationMs);
  const attemptDetails = value.attemptDetails === undefined ? undefined : decodeArray(value.attemptDetails, decodeAgentAttempt);
  const accounting = value.accounting === undefined ? undefined : decodeAgentAccounting(value.accounting);
  const toolCalls = value.toolCalls === undefined ? undefined : decodeArray(value.toolCalls, decodeAgentToolCall);
  const activity = value.activity === undefined ? undefined : decodeAgentActivity(value.activity);
  const lastEventAt = optionalNumber(value.lastEventAt);
  if (systemPrompt === INVALID_PERSISTED_VALUE || prompt === INVALID_PERSISTED_VALUE || label === INVALID_PERSISTED_VALUE || parentId === INVALID_PERSISTED_VALUE || resultPath === INVALID_PERSISTED_VALUE || parentBreadcrumb === INVALID_PERSISTED_VALUE || worktreeOwner === INVALID_PERSISTED_VALUE || role === INVALID_PERSISTED_VALUE || requestedModel === INVALID_PERSISTED_VALUE || startedAt === INVALID_PERSISTED_VALUE || durationMs === INVALID_PERSISTED_VALUE || lastEventAt === INVALID_PERSISTED_VALUE) return undefined;
  if (!model || !tools || value.structuralPath !== undefined && !structuralPath || value.attemptDetails !== undefined && !attemptDetails || value.accounting !== undefined && !accounting || value.toolCalls !== undefined && !toolCalls || value.activity !== undefined && !activity) return undefined;
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(prompt === undefined ? {} : { prompt }),
    id: value.id,
    name: value.name,
    ...(label === undefined ? {} : { label }),
    path: value.path,
    state: value.state,
    ...(parentId === undefined ? {} : { parentId }),
    ...(structuralPath === undefined ? {} : { structuralPath }),
    ...(resultPath === undefined ? {} : { resultPath }),
    ...(parentBreadcrumb === undefined ? {} : { parentBreadcrumb }),
    ...(worktreeOwner === undefined ? {} : { worktreeOwner }),
    ...(role === undefined ? {} : { role }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    model,
    tools,
    attempts: value.attempts,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(attemptDetails === undefined ? {} : { attemptDetails }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(activity === undefined ? {} : { activity }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
  };
}
function decodeRetry(value: unknown): NonNullable<RunRecord["retry"]> | undefined {
  if (!object(value) || typeof value.sourceRunId !== "string" || typeof value.lineageRootRunId !== "string") return undefined;
  const completedPaths = decodeStringArray(value.completedPaths);
  const incompletePaths = decodeStringArray(value.incompletePaths);
  const namedWorktrees = decodeStringArray(value.namedWorktrees);
  if (!completedPaths || !incompletePaths || !namedWorktrees) return undefined;
  return { sourceRunId: value.sourceRunId, lineageRootRunId: value.lineageRootRunId, completedPaths, incompletePaths, namedWorktrees };
}
function decodeWorkflowError(value: unknown): NonNullable<RunRecord["error"]> | undefined {
  if (!object(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  const code = isWorkflowErrorCode(value.code) ? value.code : "INTERNAL_ERROR";
  const failedAt = optionalString(value.failedAt);
  if (failedAt === INVALID_PERSISTED_VALUE) return undefined;
  return { code, message: value.message, ...(failedAt === undefined ? {} : { failedAt }) };
}
function decodeUsage(value: unknown): WorkflowBudgetUsage | undefined {
  if (!object(value) || !finiteNumber(value.tokens) || !finiteNumber(value.costUsd) || !finiteNumber(value.durationMs) || !finiteNumber(value.agentLaunches)) return undefined;
  return { tokens: value.tokens, costUsd: value.costUsd, durationMs: value.durationMs, agentLaunches: value.agentLaunches };
}
function decodeBudgetEvent(value: unknown): BudgetEvent | undefined {
  if (!object(value) || !isBudgetEventType(value.type) || !integer(value.budgetVersion) || !finiteNumber(value.at)) return undefined;
  const dimensions = decodeArray(value.dimensions, (entry) => isBudgetDimension(entry) ? entry : undefined);
  const usage = decodeUsage(value.usage);
  const limits = decodeBudget(value.limits);
  const proposalId = optionalString(value.proposalId);
  const previous = value.previous === undefined ? undefined : decodeBudget(value.previous);
  const proposed = value.proposed === undefined ? undefined : decodeBudget(value.proposed);
  if (!dimensions || !usage || !limits || proposalId === INVALID_PERSISTED_VALUE || value.previous !== undefined && !previous || value.proposed !== undefined && !proposed) return undefined;
  return { type: value.type, budgetVersion: value.budgetVersion, dimensions, usage, limits, at: value.at, ...(proposalId === undefined ? {} : { proposalId }), ...(previous === undefined ? {} : { previous }), ...(proposed === undefined ? {} : { proposed }) };
}
function decodePhaseRecord(value: unknown): PersistedPhaseRecord | undefined {
  if (!object(value) || typeof value.phase !== "string" || !integer(value.afterAgent)) return undefined;
  return { phase: value.phase, afterAgent: value.afterAgent };
}
function decodeShellActivity(value: unknown): PersistedShellActivity | undefined {
  if (!object(value) || !integer(value.phaseIndex) || !integer(value.active) || !finiteNumber(value.startedAt)) return undefined;
  return { phaseIndex: value.phaseIndex, active: value.active, startedAt: value.startedAt };
}
function decodeRunEvent(value: unknown): WorkflowRunEvent | undefined {
  if (!object(value) || typeof value.type !== "string" || typeof value.message !== "string") return undefined;
  const timestamp = optionalNumber(value.timestamp);
  if (timestamp === INVALID_PERSISTED_VALUE) return undefined;
  return { type: value.type, message: value.message, ...(timestamp === undefined ? {} : { timestamp }) };
}
function decodeDelivery(value: unknown): PersistedDelivery | undefined {
  if (!object(value)) return undefined;
  const mode = value.mode;
  const state = value.state;
  if (mode !== "foreground" && mode !== "background" || state !== "attached" && state !== "pending" && state !== "delivered") return undefined;
  const toolCallId = optionalString(value.toolCallId);
  if (toolCallId === INVALID_PERSISTED_VALUE) return undefined;
  return { mode, state, ...(toolCallId === undefined ? {} : { toolCallId }) };
}
function decodePersistedRun(value: unknown, allowLegacyAgentSessions = false): PersistedRun | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.workflowName !== "string" || typeof value.cwd !== "string" || typeof value.sessionId !== "string" || !isRunState(value.state)) return undefined;
  const agentSessions = value.agentSessions === undefined && allowLegacyAgentSessions ? [] : decodeArray(value.agentSessions, decodeAgentSession);
  const agents = decodeArray(value.agents, decodeAgent);
  const parentRunId = optionalString(value.parentRunId);
  const retry = value.retry === undefined ? undefined : decodeRetry(value.retry);
  const phase = optionalString(value.phase);
  const phaseHistory = value.phaseHistory === undefined ? undefined : decodeArray(value.phaseHistory, decodePhaseRecord);
  const phaseHistoryIndex = optionalNumber(value.phaseHistoryIndex);
  const activeShells = optionalNumber(value.activeShells);
  const activeShellStartedAt = optionalNumber(value.activeShellStartedAt);
  const activeShellsByPhase = value.activeShellsByPhase === undefined ? undefined : decodeArray(value.activeShellsByPhase, decodeShellActivity);
  const error = value.error === undefined ? undefined : decodeWorkflowError(value.error);
  const failedAt = optionalString(value.failedAt);
  const budget = value.budget === undefined ? undefined : decodeBudget(value.budget);
  const budgetVersion = optionalNumber(value.budgetVersion);
  const usage = value.usage === undefined ? undefined : decodeUsage(value.usage);
  const budgetEvents = value.budgetEvents === undefined ? undefined : decodeArray(value.budgetEvents, decodeBudgetEvent);
  const events = value.events === undefined ? undefined : decodeArray(value.events, decodeRunEvent);
  const delivery = value.delivery === undefined ? undefined : decodeDelivery(value.delivery);
  if (!agentSessions || !agents || parentRunId === INVALID_PERSISTED_VALUE || value.retry !== undefined && !retry || phase === INVALID_PERSISTED_VALUE || value.phaseHistory !== undefined && !phaseHistory || phaseHistoryIndex === INVALID_PERSISTED_VALUE || activeShells === INVALID_PERSISTED_VALUE || activeShellStartedAt === INVALID_PERSISTED_VALUE || value.activeShellsByPhase !== undefined && !activeShellsByPhase || value.error !== undefined && !error || failedAt === INVALID_PERSISTED_VALUE || value.budget !== undefined && !budget || budgetVersion === INVALID_PERSISTED_VALUE || value.budgetVersion !== undefined && !integer(budgetVersion) || value.usage !== undefined && !usage || value.budgetEvents !== undefined && !budgetEvents || value.events !== undefined && !events || value.delivery !== undefined && !delivery) return undefined;
  if (value.agentSessions === undefined && !allowLegacyAgentSessions) return undefined;
  return {
    id: value.id,
    workflowName: value.workflowName,
    cwd: value.cwd,
    sessionId: value.sessionId,
    state: value.state,
    agentSessions,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(retry === undefined ? {} : { retry }),
    ...(phase === undefined ? {} : { phase }),
    ...(phaseHistory === undefined ? {} : { phaseHistory }),
    ...(phaseHistoryIndex === undefined ? {} : { phaseHistoryIndex }),
    agents,
    ...(activeShells === undefined ? {} : { activeShells }),
    ...(activeShellStartedAt === undefined ? {} : { activeShellStartedAt }),
    ...(activeShellsByPhase === undefined ? {} : { activeShellsByPhase }),
    ...(error === undefined ? {} : { error }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(budget === undefined ? {} : { budget }),
    ...(budgetVersion === undefined ? {} : { budgetVersion }),
    ...(usage === undefined ? {} : { usage }),
    ...(budgetEvents === undefined ? {} : { budgetEvents }),
    ...(events === undefined ? {} : { events }),
    ...(delivery === undefined ? {} : { delivery }),
  };
}
export function isPersistedRun(value: unknown): value is PersistedRun { return decodePersistedRun(value) !== undefined; }
function decodeLaunchSnapshot(value: unknown): LaunchSnapshot | undefined {
  if (!object(value) || typeof value.script !== "string") return undefined;
  const identityVersion = optionalNumber(value.identityVersion);
  const launchMode = value.launchMode;
  const args = decodeJsonValue(value.args);
  const metadata = decodeWorkflowMetadata(value.metadata);
  const settings = decodeWorkflowSettings(value.settings);
  const settingsSources = value.settingsSources === undefined ? undefined : decodeWorkflowSettingsSources(value.settingsSources);
  const budget = value.budget === undefined ? undefined : decodeBudget(value.budget);
  const settingsPath = optionalString(value.settingsPath);
  const modelAliases = value.modelAliases === undefined ? undefined : decodeStringMap(value.modelAliases);
  const phases = value.phases === undefined ? undefined : decodeStringArray(value.phases);
  const models = decodeStringArray(value.models);
  const tools = decodeStringArray(value.tools);
  const agentTypes = decodeStringArray(value.agentTypes);
  const roles = value.roles === undefined ? undefined : decodeRecord(value.roles, decodeAgentDefinition);
  const projectRoles = value.projectRoles === undefined ? undefined : decodeStringArray(value.projectRoles);
  const schemas = decodeArray(value.schemas, decodeJsonObject);
  if (identityVersion === INVALID_PERSISTED_VALUE || value.identityVersion !== undefined && !integer(identityVersion) || launchMode !== undefined && !isLaunchMode(launchMode) || args === undefined || !metadata || !settings || value.settingsSources !== undefined && !settingsSources || value.budget !== undefined && !budget || settingsPath === INVALID_PERSISTED_VALUE || value.modelAliases !== undefined && !modelAliases || value.phases !== undefined && !phases || !models || !tools || !agentTypes || value.roles !== undefined && !roles || value.projectRoles !== undefined && !projectRoles || !schemas) return undefined;
  return {
    ...(identityVersion === undefined ? {} : { identityVersion }),
    ...(launchMode === undefined ? {} : { launchMode }),
    script: value.script,
    args,
    metadata,
    settings,
    ...(settingsSources === undefined ? {} : { settingsSources }),
    ...(budget === undefined ? {} : { budget }),
    ...(settingsPath === undefined ? {} : { settingsPath }),
    ...(modelAliases === undefined ? {} : { modelAliases }),
    ...(phases === undefined ? {} : { phases }),
    models,
    tools,
    agentTypes,
    ...(roles === undefined ? {} : { roles }),
    ...(projectRoles === undefined ? {} : { projectRoles }),
    schemas,
  };
}

function decodeSessionOwner(value: unknown): SessionOwner | undefined {
  if (!object(value) || !positiveInteger(value.pid) || typeof value.token !== "string" || !value.token || !finiteNumber(value.startedAt)) return undefined;
  return { pid: value.pid, token: value.token, startedAt: value.startedAt };
}
function decodeOwnershipRecord(value: unknown): OwnershipRecord | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.label !== "string" || !isOwnershipState(value.state)) return undefined;
  const parentId = optionalString(value.parentId);
  const prompt = optionalString(value.prompt);
  const options = decodeScheduledAgentOptions(value.options);
  if (parentId === INVALID_PERSISTED_VALUE || prompt === INVALID_PERSISTED_VALUE || !options) return undefined;
  return { id: value.id, label: value.label, state: value.state, options, ...(parentId === undefined ? {} : { parentId }), ...(prompt === undefined ? {} : { prompt }) };
}
function decodeOwnershipRecords(value: unknown): OwnershipRecord[] | undefined { return decodeArray(value, decodeOwnershipRecord); }
function decodeWorktreeReference(value: unknown): WorktreeReference | undefined {
  if (!object(value) || typeof value.owner !== "string" || typeof value.path !== "string" || typeof value.branch !== "string" || typeof value.cwd !== "string" || typeof value.base !== "string") return undefined;
  return { owner: value.owner, path: value.path, branch: value.branch, cwd: value.cwd, base: value.base };
}
function decodeWorktreeReferences(value: unknown): WorktreeReference[] | undefined { return decodeArray(value, decodeWorktreeReference); }
function decodeBorrowedWorktreeBinding(value: unknown): BorrowedWorktreeBinding | undefined {
  if (!object(value) || typeof value.name !== "string" || typeof value.sourceRunId !== "string" || typeof value.owner !== "string") return undefined;
  return { name: value.name, sourceRunId: value.sourceRunId, owner: value.owner };
}
function decodeBorrowedWorktreeBindings(value: unknown): BorrowedWorktreeBinding[] | undefined { return decodeArray(value, decodeBorrowedWorktreeBinding); }
function decodeCompletedOperation(value: unknown): CompletedOperation | undefined {
  if (!object(value) || typeof value.path !== "string") return undefined;
  const decodedValue = decodeJsonValue(value.value);
  if (decodedValue === undefined) return undefined;
  return { path: value.path, value: decodedValue };
}
function decodeAwaitingCheckpoint(value: unknown): AwaitingCheckpoint | undefined {
  if (!object(value) || typeof value.path !== "string" || typeof value.name !== "string" || typeof value.prompt !== "string") return undefined;
  const context = decodeJsonValue(value.context);
  if (context === undefined) return undefined;
  return { path: value.path, name: value.name, prompt: value.prompt, context };
}
function decodePendingWorkflowDecision(value: unknown): PendingWorkflowDecision | undefined {
  if (!object(value) || value.kind !== "budget" || typeof value.proposalId !== "string" || typeof value.runId !== "string" || !integer(value.budgetVersion)) return undefined;
  const consumed = decodeUsage(value.consumed);
  const previous = decodeBudget(value.previous);
  const proposed = decodeBudget(value.proposed);
  const foreground = optionalBoolean(value.foreground);
  if (!consumed || !previous || !proposed || foreground === INVALID_PERSISTED_VALUE) return undefined;
  return { kind: "budget", proposalId: value.proposalId, runId: value.runId, consumed, previous, proposed, budgetVersion: value.budgetVersion, ...(foreground === undefined ? {} : { foreground }) };
}
function decodeJournal(value: unknown): Journal | undefined {
  if (!object(value)) return undefined;
  const completed = decodeRecord(value.completed, decodeCompletedOperation);
  const awaiting = value.awaiting === undefined ? undefined : decodeRecord(value.awaiting, decodeAwaitingCheckpoint);
  const decisions = value.decisions === undefined ? undefined : decodeRecord(value.decisions, decodePendingWorkflowDecision);
  if (!completed || value.awaiting !== undefined && !awaiting || value.decisions !== undefined && !decisions) return undefined;
  return { completed, ...(awaiting === undefined ? {} : { awaiting }), ...(decisions === undefined ? {} : { decisions }) };
}
function decodeBooleanCheckpointResult(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function decodeSummaryProjection(value: unknown): Partial<RunSummary> | undefined {
  if (!object(value)) return undefined;
  const createdAt = optionalString(value.createdAt);
  const updatedAt = optionalString(value.updatedAt);
  const terminalAt = optionalString(value.terminalAt);
  if (createdAt === INVALID_PERSISTED_VALUE || updatedAt === INVALID_PERSISTED_VALUE || terminalAt === INVALID_PERSISTED_VALUE) return undefined;
  return { ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }), ...(terminalAt === undefined ? {} : { terminalAt }) };
}
function decodeEffectiveSystemPrompt(value: unknown): EffectiveSystemPrompt | undefined {
  if (!object(value) || typeof value.sessionId !== "string" || !positiveInteger(value.attempt) || !positiveInteger(value.turn) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.prompt !== "string") return undefined;
  return { sessionId: value.sessionId, attempt: value.attempt, turn: value.turn, sha256: value.sha256, prompt: value.prompt };
}
function decodeSystemPromptArtifact(value: unknown): { version: number; format?: unknown; storage?: unknown; entries?: EffectiveSystemPrompt[] } | undefined {
  if (!object(value) || !finiteNumber(value.version)) return undefined;
  const entries = value.entries === undefined ? undefined : decodeArray(value.entries, decodeEffectiveSystemPrompt);
  if (value.entries !== undefined && !entries) return undefined;
  return { version: value.version, ...(value.format === undefined ? {} : { format: value.format }), ...(value.storage === undefined ? {} : { storage: value.storage }), ...(entries === undefined ? {} : { entries }) };
}
const TERMINAL_SUMMARY_STATES = new Set(["completed", "failed", "stopped"]);
const EMPTY_USAGE: WorkflowBudgetUsage = { tokens: 0, costUsd: 0, durationMs: 0, agentLaunches: 0 };
const SYSTEM_PROMPT_STORAGE = ".system-prompts";
const SYSTEM_PROMPT_RECORDS = "records";
const SYSTEM_PROMPT_BODIES = "bodies";
const SYSTEM_PROMPT_SEQUENCE = "sequence";
const SYSTEM_PROMPT_ARTIFACT = { version: 2 as const, format: "append-only" as const, storage: SYSTEM_PROMPT_STORAGE };
function summaryArtifacts(directory: string): RunSummaryArtifacts { return { runDirectory: directory, statePath: join(directory, "state.json"), journalPath: join(directory, "journal.json"), snapshotPath: join(directory, "snapshot.json"), workflowPath: join(directory, "workflow.js"), resultPath: join(directory, "result.json"), summaryPath: join(directory, "summary.json") }; }
function summaryFromRun(run: PersistedRun, directory: string, journal: Journal, previous: Partial<RunSummary> | undefined, fallbackCreatedAt: string, now = new Date().toISOString()): RunSummary {
  const createdAt = typeof previous?.createdAt === "string" ? previous.createdAt : fallbackCreatedAt;
  const failedAt = run.failedAt ?? run.error?.failedAt;
  const replayablePaths = [...new Set([...(run.retry?.completedPaths ?? []), ...Object.keys(journal.completed)])];
  const incompletePaths = [...new Set([...(run.retry?.incompletePaths ?? []), ...(failedAt ? [failedAt] : [])])];
  return { schemaVersion: 1, runId: run.id, sessionId: run.sessionId, workflowName: run.workflowName, state: run.state, createdAt, updatedAt: now, ...(previous?.terminalAt || TERMINAL_SUMMARY_STATES.has(run.state) ? { terminalAt: previous?.terminalAt ?? now } : {}), usage: { ...EMPTY_USAGE, ...(run.usage ?? {}) }, agents: run.agents.map(({ id, name, label, state, role, attempts }) => ({ id, name, ...(label ? { label } : {}), state, ...(role ? { role } : {}), attempts })), ...(run.error ? { error: run.error } : {}), ...(failedAt ? { failedAt } : {}), replayablePaths, incompletePaths, artifacts: summaryArtifacts(directory) };
}
export interface WorktreeReference { owner: string; path: string; branch: string; cwd: string; base: string }
export interface BorrowedWorktreeBinding { name: string; sourceRunId: string; owner: string }

const execute = promisify(execFile);
const gitIdentity = {
  GIT_AUTHOR_NAME: "pi-extensible-workflows", GIT_AUTHOR_EMAIL: "pi-extensible-workflows@localhost", GIT_COMMITTER_NAME: "pi-extensible-workflows", GIT_COMMITTER_EMAIL: "pi-extensible-workflows@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function safePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }

export function projectStorageKey(cwd: string): string {
  const exact = resolve(cwd);
  const slug = safePart(basename(exact)) || "root";
  return `${slug}-${createHash("sha256").update(exact).digest("hex").slice(0, 12)}`;
}

export function projectSessionsDirectory(cwd: string, home = homedir()): string {
  return join(home, ".pi", "workflows", "projects", projectStorageKey(cwd), "sessions");
}
export function runsDirectory(cwd: string, sessionId: string, home = homedir()): string {
  return join(projectSessionsDirectory(cwd, home), safePart(sessionId), "runs");
}
export async function listPersistedSessionIds(cwd: string, home = homedir()): Promise<string[]> {
  try {
    const entries = await readdir(projectSessionsDirectory(cwd, home), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(({ name }) => name);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

const SESSION_OWNER_FILE = "owner.json";
const SESSION_OWNER_WRITE_GRACE_MS = 30_000;
const RUN_CREATE_TEMP = /^\.([a-zA-Z0-9._-]+)\.(\d+)\.[0-9a-f-]+\.tmp$/;
type SessionOwner = { pid: number; token: string; startedAt: number };

async function processAlive(pid: number, startedAt?: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch (error) { return !isNodeError(error, "ESRCH"); }
  if (startedAt !== undefined && process.platform === "linux") {
    try { if ((await stat(`/proc/${String(pid)}`)).ctimeMs > startedAt) return false; }
    catch (error) { if (isNodeError(error, "ENOENT")) return false; }
  }
  return true;
}
export async function hasLiveSessionLease(cwd: string, sessionId: string, home = homedir()): Promise<boolean> {
  const path = join(runsDirectory(cwd, sessionId, home), SESSION_OWNER_FILE);
  let owner: unknown;
  try { owner = await json(path); }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
  const candidate = decodeSessionOwner(owner);
  if (!candidate) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} has an invalid ownership lease`);
  return processAlive(candidate.pid, candidate.startedAt);
}

function sameOwner(left: unknown, right: unknown): boolean {
  if (!object(left) || !object(right)) return false;
  return left.pid === right.pid && left.token === right.token;
}

async function restoreLease(path: string, stale: string): Promise<void> {
  try { await link(stale, path); }
  catch (error) {
    if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOENT")) throw error;
  }
  await rm(stale, { force: true });
}

async function cleanupRunTemps(directory: string, entries: readonly { name: string; isDirectory(): boolean }[]): Promise<void> {
  await Promise.all(entries.map(async (entry) => {
    const match = entry.isDirectory() ? RUN_CREATE_TEMP.exec(entry.name) : undefined;
    const pid = match?.[2] ? Number(match[2]) : undefined;
    if (pid && !await processAlive(pid)) await rm(join(directory, entry.name), { recursive: true, force: true });
  }));
}

export class SessionLease {
  #released = false;
  constructor(readonly path: string, readonly token: string) {}
  get active(): boolean { return !this.#released; }
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      const owner = decodeSessionOwner(await json(this.path));
      if (owner?.token === this.token) await rm(this.path, { force: true });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

export async function acquireSessionLease(cwd: string, sessionId: string, home = homedir()): Promise<SessionLease> {
  const directory = runsDirectory(cwd, sessionId, home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SESSION_OWNER_FILE);
  for (;;) {
    const token = randomUUID();
    const owner: SessionOwner = { pid: process.pid, token, startedAt: process.platform === "linux" ? (await stat(`/proc/${String(process.pid)}`)).ctimeMs : Date.now() };
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); } finally { await handle.close(); }
      return new SessionLease(path, token);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      let existing: unknown;
      let existingText = "";
      try {
        existingText = await readFile(path, "utf8");
        existing = JSON.parse(existingText);
        const candidate = decodeSessionOwner(existing);
        if (candidate && await processAlive(candidate.pid, candidate.startedAt)) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} is already owned by process ${String(candidate.pid)}`);
      } catch (readError) {
        if (readError instanceof WorkflowError) throw readError;
        if (isNodeError(readError, "ENOENT")) continue;
        const age = await stat(path).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        if (age < SESSION_OWNER_WRITE_GRACE_MS) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} has an active ownership lease`);
        existing = undefined;
      }
      const stale = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, stale);
        const movedText = await readFile(stale, "utf8");
        let moved: unknown;
        try { moved = JSON.parse(movedText); }
        catch {
          if (movedText === existingText) await rm(stale, { force: true });
          else await restoreLease(path, stale);
          continue;
        }
        if (!sameOwner(existing, moved)) { await restoreLease(path, stale); continue; }
        await rm(stale, { force: true });
      }
      catch (reclaimError) { if (isNodeError(reclaimError, "ENOENT")) continue; throw reclaimError; }
    }
  }
}

export async function listRunIds(cwd: string, sessionId: string, home = homedir(), cleanTemps = true): Promise<string[]> {
  const directory = runsDirectory(cwd, sessionId, home);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (cleanTemps) await cleanupRunTemps(directory, entries);
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(({ name }) => name);
  }
  catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
}

export function structuralPath(...names: string[]): string {
  if (names.length === 0 || names.some((name) => name.trim() === "")) throw new WorkflowError("INVALID_METADATA", "Structural paths require non-empty explicit names");
  return names.map((name) => encodeURIComponent(name)).join("/");
}

export function atomicWriteFile(path: string, content: string): Promise<void>;
export function atomicWriteFile(path: string, content: string, sync: true): void;
export function atomicWriteFile(path: string, content: string, sync = false): Promise<void> | void {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  if (sync) {
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
      throw error;
    }
    return;
  }
  return writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }).then(() => rename(temporary, path)).catch(async (error: unknown) => {
    try { await rm(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  });
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value)}\n`);
}

async function atomicPrettyJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
function systemPromptStoragePath(directory: string): string { return join(directory, SYSTEM_PROMPT_STORAGE); }
function systemPromptRecordsPath(directory: string): string { return join(systemPromptStoragePath(directory), SYSTEM_PROMPT_RECORDS); }
function systemPromptBodiesPath(directory: string): string { return join(systemPromptStoragePath(directory), SYSTEM_PROMPT_BODIES); }
function systemPromptSequencePath(directory: string): string { return join(systemPromptStoragePath(directory), SYSTEM_PROMPT_SEQUENCE); }
function systemPromptRecordName(sequence: number): string { return `${String(sequence).padStart(20, "0")}.json`; }
async function createSystemPromptStorage(directory: string, writeArtifact: boolean): Promise<void> {
  const storage = systemPromptStoragePath(directory);
  await mkdir(join(storage, SYSTEM_PROMPT_RECORDS), { recursive: true, mode: 0o700 });
  await mkdir(join(storage, SYSTEM_PROMPT_BODIES), { recursive: true, mode: 0o700 });
  await atomicWriteFile(systemPromptSequencePath(directory), "0\n");
  if (writeArtifact) await atomicJson(join(directory, "system-prompts.json"), SYSTEM_PROMPT_ARTIFACT);
}

export class RunStore {
  readonly directory: string;
  private journalWrite: Promise<void> = Promise.resolve();
  // ponytail: serializes one RunStore instance; cross-process run sharing remains unsupported.
  private stateWrite: Promise<void> = Promise.resolve();
  private summaryWrite: Promise<void> = Promise.resolve();
  private worktreeWrite: Promise<void> = Promise.resolve();
  private borrowedWorktreeWrite: Promise<void> = Promise.resolve();
  private snapshotWrite: Promise<void> = Promise.resolve();
  private launchSnapshotWrite: Promise<void> = Promise.resolve();
  // ponytail: the session lease prevents concurrent RunStore writers for one run.
  private systemPromptWrite: Promise<void> = Promise.resolve();
  constructor(readonly cwd: string, readonly sessionId: string, readonly runId: string, readonly home = homedir()) {
    this.cwd = resolve(cwd);
    this.directory = join(runsDirectory(this.cwd, sessionId, home), safePart(runId));
  }

  async create(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
    const temporary = join(dirname(this.directory), `.${safePart(this.runId)}.${String(process.pid)}.${randomUUID()}.tmp`);
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeFile(join(temporary, "workflow.js"), snapshot.script, { encoding: "utf8", mode: 0o600 });
      await atomicJson(join(temporary, "snapshot.json"), snapshot);
      await atomicJson(join(temporary, "journal.json"), { completed: {}, awaiting: {}, decisions: {} });
      await atomicJson(join(temporary, "ownership.json"), []);
      await atomicJson(join(temporary, "worktrees.json"), []);
      await atomicJson(join(temporary, "borrowed-worktrees.json"), []);
      await atomicJson(join(temporary, "state.json"), run);
      await createSystemPromptStorage(temporary, true);
      await atomicJson(join(temporary, "summary.json"), summaryFromRun(run, this.directory, { completed: {} }, undefined, new Date().toISOString()));
      await rename(temporary, this.directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  private async refreshSummary(): Promise<void> {
    const write = this.summaryWrite.then(async () => {
      const run = decodePersistedRun(await json(join(this.directory, "state.json")), true);
      const journal = decodeJournal(await json(join(this.directory, "journal.json")));
      const previous = await json(join(this.directory, "summary.json")).then(decodeSummaryProjection).catch(() => undefined);
      if (!run || !journal) throw new Error("Persisted run or journal is invalid");
      const fallbackCreatedAt = await stat(join(this.directory, "state.json")).then((value) => new Date(value.mtimeMs).toISOString());
      await atomicJson(join(this.directory, "summary.json"), summaryFromRun(run, this.directory, journal, previous, fallbackCreatedAt));
    });
    this.summaryWrite = write.catch(() => undefined);
    await write;
  }
  private refreshSummaryBestEffort(): void { void this.refreshSummary().catch(() => undefined); }

  async isComplete(): Promise<boolean> {
    try { await Promise.all([access(join(this.directory, "snapshot.json")), access(join(this.directory, "journal.json")), access(join(this.directory, "ownership.json")), access(join(this.directory, "state.json"))]); return true; }
    catch { return false; }
  }

  async load(): Promise<{ run: LoadedPersistedRun; snapshot: Readonly<LaunchSnapshot> }> {
    await this.stateWrite;
    const rawRun = await json(join(this.directory, "state.json"));
    const run = decodePersistedRun(rawRun, true);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run is invalid");
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
    if (!object(rawRun) || !Array.isArray(rawRun.agentSessions) || Object.hasOwn(rawRun, "nativeSessions")) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run uses an unsupported agent session format");
    const snapshot = decodeLaunchSnapshot(await json(join(this.directory, "snapshot.json")));
    if (!snapshot) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted launch snapshot is invalid");
    return { run, snapshot: loadLaunchSnapshot(snapshot) };
  }
  async loadStatus(): Promise<PersistedRun> {
    await this.stateWrite;
    const run = decodePersistedRun(await json(join(this.directory, "state.json")), true);
    if (!run) throw new WorkflowError("RUN_NOT_FOUND", "Persisted run is invalid");
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("RUN_NOT_FOUND", "Persisted run does not belong to this project");
    return run;
  }
  async loadSummary(): Promise<RunSummary> {
    await this.stateWrite;
    await this.journalWrite;
    await this.summaryWrite;
    const run = decodePersistedRun(await json(join(this.directory, "state.json")), true);
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    const previous = await json(join(this.directory, "summary.json")).then(decodeSummaryProjection).catch(() => undefined);
    if (!run || !journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run or journal is invalid");
    const [stateStat, journalStat] = await Promise.all([stat(join(this.directory, "state.json")), stat(join(this.directory, "journal.json"))]);
    const fallbackCreatedAt = new Date(stateStat.mtimeMs).toISOString();
    const previousUpdatedAt = previous?.updatedAt === undefined ? Number.NaN : Date.parse(previous.updatedAt);
    const updatedAt = new Date(Math.max(stateStat.mtimeMs, journalStat.mtimeMs, Number.isNaN(previousUpdatedAt) ? 0 : previousUpdatedAt)).toISOString();
    return summaryFromRun(run, this.directory, journal, previous, fallbackCreatedAt, updatedAt);
  }

  async saveState(run: PersistedRun): Promise<void> {
    const write = this.stateWrite.then(async () => {
      if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
      await atomicJson(join(this.directory, "state.json"), run);
      this.refreshSummaryBestEffort();
    });
    this.stateWrite = write.catch(() => undefined);
    await write;
  }

  async updateState(update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>): Promise<PersistedRun> {
    const write = this.stateWrite.then(async () => {
      const current = decodePersistedRun(await json(join(this.directory, "state.json")));
      if (!current) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run is invalid");
      if (resolve(current.cwd) !== this.cwd || current.sessionId !== this.sessionId || current.id !== this.runId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
      const result = await update(current);
      if (resolve(result.cwd) !== this.cwd || result.sessionId !== this.sessionId || result.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
      await atomicJson(join(this.directory, "state.json"), result);
      this.refreshSummaryBestEffort();
      return result;
    });
    this.stateWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  async saveSnapshot(snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    const write = this.launchSnapshotWrite.then(() => atomicJson(join(this.directory, "snapshot.json"), snapshot));
    this.launchSnapshotWrite = write.catch(() => undefined);
    await write;
  }

  async appendEvent(event: WorkflowRunEvent): Promise<void> {
    await this.updateState((run) => ({ ...run, events: [...(run.events ?? []), ...(event.type !== "log" && run.events?.some((current) => current.type === event.type && current.message === event.message) ? [] : [event])] }));
  }

  async saveOwnership(nodes: readonly PersistedOwnershipNode[]): Promise<void> {
    await atomicJson(join(this.directory, "ownership.json"), nodes);
  }

  async loadOwnership(): Promise<readonly PersistedOwnershipNode[]> {
    const nodes = decodeOwnershipRecords(await json(join(this.directory, "ownership.json")));
    if (!nodes) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted ownership records are invalid");
    return nodes;
  }

  systemPromptPath(): string { return join(this.directory, "system-prompts.json"); }
  private async readSystemPromptArtifact(): Promise<{ version: number; format?: unknown; storage?: unknown; entries?: EffectiveSystemPrompt[] } | undefined> {
    try {
      const artifact = decodeSystemPromptArtifact(await json(this.systemPromptPath()));
      if (!artifact) throw new Error("Persisted system prompts are invalid");
      return artifact;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async appendSystemPromptV2(entry: Omit<EffectiveSystemPrompt, "sha256">): Promise<void> {
    const sha256 = createHash("sha256").update(entry.prompt).digest("hex");
    const bodyPath = join(systemPromptBodiesPath(this.directory), sha256);
    try { await access(bodyPath); }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; await atomicWriteFile(bodyPath, entry.prompt); }
    const previous = Number(await readFile(systemPromptSequencePath(this.directory), "utf8"));
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error("Persisted system-prompt sequence is invalid");
    const sequence = previous + 1;
    await atomicWriteFile(systemPromptSequencePath(this.directory), `${String(sequence)}\n`);
    await atomicJson(join(systemPromptRecordsPath(this.directory), systemPromptRecordName(sequence)), { sessionId: entry.sessionId, attempt: entry.attempt, turn: entry.turn, sha256 });
  }
  private async migrateSystemPrompts(legacy: { version: number; entries?: EffectiveSystemPrompt[] }): Promise<void> {
    await rm(systemPromptStoragePath(this.directory), { recursive: true, force: true });
    await createSystemPromptStorage(this.directory, false);
    for (const entry of legacy.entries ?? []) await this.appendSystemPromptV2(entry);
    await atomicJson(this.systemPromptPath(), SYSTEM_PROMPT_ARTIFACT);
  }
  private async prepareSystemPromptStorage(): Promise<void> {
    const artifact = await this.readSystemPromptArtifact();
    if (artifact === undefined) {
      await rm(systemPromptStoragePath(this.directory), { recursive: true, force: true });
      await createSystemPromptStorage(this.directory, true);
    } else if (artifact.version === 1) {
      if (!Array.isArray(artifact.entries)) throw new Error("Persisted system prompts are invalid");
      await this.migrateSystemPrompts(artifact);
    } else if (artifact.version !== SYSTEM_PROMPT_ARTIFACT.version || artifact.format !== SYSTEM_PROMPT_ARTIFACT.format || artifact.storage !== SYSTEM_PROMPT_ARTIFACT.storage) throw new Error("Persisted system prompts are invalid");
  }
  private async readSystemPromptsV2(): Promise<readonly EffectiveSystemPrompt[]> {
    const artifact = await this.readSystemPromptArtifact();
    if (!artifact || artifact.version !== SYSTEM_PROMPT_ARTIFACT.version || artifact.format !== SYSTEM_PROMPT_ARTIFACT.format || artifact.storage !== SYSTEM_PROMPT_ARTIFACT.storage) throw new Error("Persisted system prompts are invalid");
    const sequence = Number(await readFile(systemPromptSequencePath(this.directory), "utf8"));
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Persisted system-prompt sequence is invalid");
    const names = (await readdir(systemPromptRecordsPath(this.directory))).filter((name) => !name.endsWith(".tmp")).sort();
    const entries: EffectiveSystemPrompt[] = [];
    let highest = 0;
    for (const name of names) {
      const match = /^(\d{20})\.json$/.exec(name);
      if (!match) throw new Error("Persisted system-prompt records are invalid");
      const recordSequence = Number(match[1]);
      if (!Number.isSafeInteger(recordSequence) || recordSequence < 1) throw new Error("Persisted system-prompt records are invalid");
      highest = Math.max(highest, recordSequence);
      const record = await json(join(systemPromptRecordsPath(this.directory), name));
      if (!object(record)) throw new Error("Persisted system-prompt record is invalid");
      const sessionId = record.sessionId;
      const attempt = record.attempt;
      const turn = record.turn;
      const sha256 = record.sha256;
      if (typeof sessionId !== "string" || !sessionId || !positiveInteger(attempt) || !positiveInteger(turn) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Persisted system-prompt record is invalid");
      const prompt = await readFile(join(systemPromptBodiesPath(this.directory), sha256), "utf8");
      if (createHash("sha256").update(prompt).digest("hex") !== sha256) throw new Error("Persisted system-prompt body is invalid");
      entries.push({ sessionId, attempt, turn, sha256, prompt });
    }
    if (sequence < highest) throw new Error("Persisted system-prompt sequence is invalid");
    return entries;
  }
  async recordSystemPrompt(entry: Omit<EffectiveSystemPrompt, "sha256">): Promise<void> {
    const write = this.systemPromptWrite.then(async () => {
      await this.prepareSystemPromptStorage();
      await this.appendSystemPromptV2(entry);
    });
    this.systemPromptWrite = write.catch(() => undefined);
    await write;
  }
  async systemPrompts(): Promise<readonly EffectiveSystemPrompt[]> {
    await this.systemPromptWrite;
    const artifact = await this.readSystemPromptArtifact();
    if (artifact === undefined) return [];
    if (artifact.version === 1) return artifact.entries ?? [];
    if (artifact.version === SYSTEM_PROMPT_ARTIFACT.version) return this.readSystemPromptsV2();
    throw new Error("Persisted system prompts are invalid");
  }

  private async updateJournal<T>(update: (journal: Journal) => T | Promise<T>): Promise<T> {
    const write = this.journalWrite.then(async () => {
      const journalPath = join(this.directory, "journal.json");
      const journal = decodeJournal(await json(journalPath));
      if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
      journal.awaiting ??= {};
      const result = await update(journal);
      await atomicJson(journalPath, journal);
      this.refreshSummaryBestEffort();
      return result;
    });
    this.journalWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  async complete(path: string, value: JsonValue): Promise<void> {
    await this.updateJournal((journal) => {
      if (journal.completed[path]) throw new WorkflowError("DUPLICATE_NAME", `Completed structural path already exists: ${path}`);
      journal.completed[path] = { path, value };
    });
  }

  async replay(path: string): Promise<CompletedOperation | undefined> {
    const operations = await this.replayableOperations();
    return operations.find((operation) => operation.path === path);
  }

  async replayableOperations(): Promise<readonly CompletedOperation[]> {
    return this.replayableOperationsFrom(new Set());
  }

  private async replayableOperationsFrom(seen: Set<string>): Promise<readonly CompletedOperation[]> {
    if (seen.has(this.runId)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance contains a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    await this.journalWrite;
    const loaded = await this.load();
    const operations = new Map<string, CompletedOperation>();
    if (loaded.run.retry?.sourceRunId) {
      const source = await this.sourceRun(loaded.run.retry.sourceRunId);
      for (const operation of await source.replayableOperationsFrom(nextSeen)) operations.set(operation.path, operation);
    }
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    for (const operation of Object.values(journal.completed)) operations.set(operation.path, operation);
    return [...operations.values()].map((operation) => structuredClone(operation));
  }

  async awaitCheckpoint(checkpoint: AwaitingCheckpoint): Promise<boolean | undefined> {
    const replayed = await this.replay(checkpoint.path);
    if (replayed) {
      const result = decodeBooleanCheckpointResult(replayed.value);
      if (result === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted checkpoint result is invalid");
      return result;
    }
    return this.updateJournal((journal) => {
      const completed = journal.completed[checkpoint.path];
      if (completed) {
        const result = decodeBooleanCheckpointResult(completed.value);
        if (result === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted checkpoint result is invalid");
        return result;
      }
      const awaiting = journal.awaiting ?? (journal.awaiting = {});
      awaiting[checkpoint.path] = checkpoint;
      return undefined;
    });
  }

  async awaitingCheckpoints(): Promise<readonly AwaitingCheckpoint[]> {
    await this.journalWrite;
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    return Object.values(journal.awaiting ?? {});
  }
  async requestWorkflowDecision(request: PendingWorkflowDecision): Promise<void> {
    await this.updateJournal((journal) => { journal.decisions ??= {}; journal.decisions[request.proposalId] = request; });
  }
  async pendingWorkflowDecisions(): Promise<readonly PendingWorkflowDecision[]> {
    await this.journalWrite;
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    return Object.values(journal.decisions ?? {});
  }
  async answerWorkflowDecision(proposalId: string, approved: boolean): Promise<PendingWorkflowDecision | undefined> {
    return this.updateJournal((journal) => {
      const request = journal.decisions?.[proposalId];
      if (!request) return undefined;
      journal.completed[`decision/${proposalId}`] = { path: `decision/${proposalId}`, value: approved };
      delete journal.decisions?.[proposalId];
      return request;
    });
  }

  async answerCheckpoint(name: string, approved: boolean): Promise<AwaitingCheckpoint | undefined> {
    return this.updateJournal((journal) => {
      const checkpoint = Object.values(journal.awaiting ?? {}).find((item) => item.name === name);
      if (!checkpoint || journal.completed[checkpoint.path]) return undefined;
      journal.completed[checkpoint.path] = { path: checkpoint.path, value: approved };
      journal.awaiting = Object.fromEntries(Object.entries(journal.awaiting ?? {}).filter(([path]) => path !== checkpoint.path));
      return checkpoint;
    });
  }

  private expectedWorktree(owner: string): Pick<WorktreeReference, "path" | "branch"> {
    const key = createHash("sha256").update(`${this.sessionId}\0${this.runId}\0${owner}`).digest("hex").slice(0, 16);
    return { path: join(this.directory, "worktrees", key), branch: `pi-extensible-workflows/${safePart(this.runId)}/${key}` };
  }

  private markerPath(owner: string): string {
    const key = createHash("sha256").update(`${this.sessionId}\0${this.runId}\0${owner}`).digest("hex").slice(0, 16);
    return join(this.directory, `worktree-${key}.creating`);
  }

  private namedWorktreeOwner(name: string): string {
    if (!name.trim()) throw new WorkflowError("WORKTREE_FAILED", "Named worktree names must be non-empty");
    return structuralPath("worktree", "named", name.trim());
  }

  private worktreeName(owner: string): string | undefined {
    const prefix = `${structuralPath("worktree", "named")}/`;
    if (!owner.startsWith(prefix)) return undefined;
    const encoded = owner.slice(prefix.length);
    if (!encoded || encoded.includes("/")) return undefined;
    try {
      const name = decodeURIComponent(encoded);
      return name.trim() ? name : undefined;
    } catch {
      return undefined;
    }
  }

  private structuralWorktree(owner: string, record: WorktreeReference): WorktreeReference {
    const expected = this.expectedWorktree(owner);
    const relativePath = relative(this.directory, record.path);
    const relativeCwd = relative(record.path, record.cwd);
    if (record.owner !== owner || resolve(record.path) !== expected.path || record.branch !== expected.branch || relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) throw new Error(`Invalid worktree record for ${owner}`);
    return record;
  }

  private async borrowedWorktreeRecords(wait = true): Promise<readonly BorrowedWorktreeBinding[]> {
    if (wait) await this.borrowedWorktreeWrite;
    const rawRecords = await json(join(this.directory, "borrowed-worktrees.json")).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    const records = decodeBorrowedWorktreeBindings(rawRecords);
    if (!records) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings are invalid");
    const seen = new Set<string>();
    return records.map((candidate) => {
      if (!candidate.name.trim() || candidate.name !== candidate.name.trim() || !candidate.sourceRunId || candidate.owner !== this.namedWorktreeOwner(candidate.name)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree binding is invalid");
      if (seen.has(candidate.name)) throw new WorkflowError("WORKTREE_FAILED", `Duplicate borrowed worktree binding for ${candidate.name}`);
      seen.add(candidate.name);
      return candidate;
    });
  }
  async borrowedWorktrees(): Promise<readonly BorrowedWorktreeBinding[]> { return this.borrowedWorktreeRecords(); }

  private async borrowedWorktree(name: string): Promise<BorrowedWorktreeBinding | undefined> {
    return (await this.borrowedWorktreeRecords()).find((binding) => binding.name === name);
  }

  private async sourceRun(sourceRunId: string): Promise<RunStore> {
    if (!sourceRunId || sourceRunId === this.runId) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree source run is invalid");
    const source = new RunStore(this.cwd, this.sessionId, sourceRunId, this.home);
    try {
      const loaded = await source.load();
      if (!["completed", "failed", "stopped"].includes(loaded.run.state)) throw new Error(`Source run ${sourceRunId} is not terminal`);
      return source;
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "WORKTREE_FAILED") throw error;
      throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async validateParentRun(parentRunId: string): Promise<void> { await this.sourceRun(parentRunId); }
  async validateRetrySource(): Promise<void> {
    const validate = async (current: RunStore, seen: Set<string>): Promise<void> => {
      if (seen.has(current.runId)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance contains a cycle");
      const nextSeen = new Set(seen);
      nextSeen.add(current.runId);
      const loaded = await current.load();
      const retry = loaded.run.retry;
      if (!retry) return;
      if (typeof retry.sourceRunId !== "string" || !retry.sourceRunId || retry.sourceRunId === current.runId || typeof retry.lineageRootRunId !== "string" || !retry.lineageRootRunId || !Array.isArray(retry.completedPaths) || retry.completedPaths.some((path) => typeof path !== "string") || !Array.isArray(retry.incompletePaths) || retry.incompletePaths.some((path) => typeof path !== "string") || !Array.isArray(retry.namedWorktrees) || retry.namedWorktrees.some((name) => typeof name !== "string")) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance is incomplete");
      const source = await current.sourceRun(retry.sourceRunId);
      const sourceRun = (await source.load()).run;
      if (loaded.run.parentRunId !== retry.sourceRunId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry parent run does not match its source run");
      if (sourceRun.state !== "failed") throw new WorkflowError("RESUME_INCOMPATIBLE", `Retry source run ${retry.sourceRunId} is not failed`);
      const expectedLineageRoot = sourceRun.retry?.lineageRootRunId ?? sourceRun.id;
      if (retry.lineageRootRunId !== expectedLineageRoot) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry lineage root does not match its source run");
      await validate(source, nextSeen);
    };
    try { await validate(this, new Set()); }
    catch (error) { throw error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" ? error : new WorkflowError("RESUME_INCOMPATIBLE", error instanceof Error ? error.message : String(error)); }
  }

  private async ownedWorktree(owner: string, cwd?: string): Promise<WorktreeReference> {
    const records = decodeWorktreeReferences(await json(join(this.directory, "worktrees.json")));
    if (!records) throw new Error("Worktree records are invalid");
    const matches = records.filter((candidate) => candidate.owner === owner);
    if (matches.length !== 1) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const record = matches[0];
    if (!record) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const validated = this.structuralWorktree(owner, record);
    if (cwd !== undefined && resolve(cwd) !== resolve(validated.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
    await access(validated.cwd);
    return validated;
  }

  private async resolveBorrowedWorktree(binding: BorrowedWorktreeBinding, seen: Set<string>): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    try {
      const source = await this.sourceRun(binding.sourceRunId);
      const resolved = await source.findNamedWorktree(binding.name, seen);
      if (!resolved) throw new Error(`Missing named worktree ${binding.name} in source run ${binding.sourceRunId}`);
      if (resolved.owner !== binding.owner) throw new Error(`Borrowed worktree binding does not match source owner for ${binding.name}`);
      return resolved;
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async findNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const owner = this.namedWorktreeOwner(name);
    if (seen.has(this.runId)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings contain a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    const binding = await this.borrowedWorktree(name);
    if (binding) {
      const loaded = await this.load();
      if (loaded.run.parentRunId === undefined) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree ${name} has no parent run`);
      const parent = await this.sourceRun(loaded.run.parentRunId);
      const resolved = await parent.findNamedWorktree(name, nextSeen);
      if (!resolved || resolved.sourceRunId !== binding.sourceRunId || resolved.owner !== binding.owner) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${name} is not inherited from its parent run`);
      return resolved;
    }
    const records = decodeWorktreeReferences(await json(join(this.directory, "worktrees.json")));
    if (!records) throw new WorkflowError("WORKTREE_FAILED", "Worktree records are invalid");
    const matches = records.filter((candidate) => candidate.owner === owner);
    if (matches.length === 0) {
      const loaded = await this.load();
      if (loaded.run.parentRunId === undefined) return undefined;
      const parent = await this.sourceRun(loaded.run.parentRunId);
      return parent.findNamedWorktree(name, nextSeen);
    }
    try {
      const reference = await this.ownedWorktree(owner);
      return { reference, sourceRunId: this.runId, owner };
    } catch (error) {
      throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async resolveNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    const resolved = await this.findNamedWorktree(name, seen);
    if (!resolved) throw new WorkflowError("WORKTREE_FAILED", `Missing named worktree ${name}`);
    return resolved;
  }
  async validateDeletionWorktrees(): Promise<void> {
    try {
      const records = decodeWorktreeReferences(await json(join(this.directory, "worktrees.json")));
      if (!records) throw new Error("Worktree records are invalid");
      const owners = new Set<string>();
      const paths = new Set<string>();
      for (const record of records) {
        const owner = record.owner;
        if (owners.has(owner)) throw new Error(`Duplicate worktree record for ${owner}`);
        owners.add(owner);
        const reference = this.structuralWorktree(owner, record);
        paths.add(resolve(reference.path));
      }
      const entries = await readdir(join(this.directory, "worktrees"), { withFileTypes: true }).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return [] as import("node:fs").Dirent[]; throw error; });
      for (const entry of entries) if (!entry.isDirectory() || entry.isSymbolicLink() || !paths.has(resolve(join(this.directory, "worktrees", entry.name)))) throw new Error(`Unrecorded worktree artifact: ${join(this.directory, "worktrees", entry.name)}`);
    } catch (error) {
      throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }


  async validateBorrowedWorktrees(): Promise<void> {
    try {
      const loaded = await this.load();
      if (loaded.run.parentRunId !== undefined) await this.validateParentRun(loaded.run.parentRunId);
      for (const binding of await this.borrowedWorktreeRecords()) await this.resolveBorrowedWorktree(binding, new Set([this.runId]));
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
  async validateNamedWorktrees(): Promise<void> {
    try {
      const records = decodeWorktreeReferences(await json(join(this.directory, "worktrees.json")));
      if (!records) throw new Error("Worktree records are invalid");
      for (const record of records) {
        const owner = record.owner;
        if (this.worktreeName(owner)) await this.validateWorktree(owner);
      }
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async ownsWorktree(owner: string): Promise<boolean> {
    const records = decodeWorktreeReferences(await json(join(this.directory, "worktrees.json")));
    return records?.filter((candidate) => candidate.owner === owner).length === 1;
  }

  private async cleanupMarker(markerPath: string): Promise<void> {
    let marker: Record<string, unknown>;
    try {
      const parsed = await json(markerPath);
      if (!object(parsed)) return;
      marker = parsed;
    } catch { return; }
    if (typeof marker.owner !== "string" || typeof marker.base !== "string") return;
    const expected = this.expectedWorktree(marker.owner);
    if (marker.path !== expected.path || marker.branch !== expected.branch) return;
    const root = await git(this.cwd, ["rev-parse", "--show-toplevel"]).then((value) => value.trim()).catch(() => "");
    if (!root) return;
    const branchBase = await git(root, ["rev-parse", "--verify", `${expected.branch}^{commit}`]).then((value) => value.trim()).catch(() => "");
    if (branchBase !== marker.base) return;
    await git(root, ["worktree", "remove", "--force", expected.path]).catch(() => undefined);
    await git(root, ["branch", "-D", expected.branch]).catch(() => undefined);
    await rm(expected.path, { recursive: true, force: true });
    await rm(markerPath, { force: true });
  }

  private async cleanupOrphanWorktrees(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    for (const entry of entries.filter((name) => name.endsWith(".creating"))) await this.cleanupMarker(join(this.directory, entry));
  }

  async validateWorktree(owner: string, cwd?: string): Promise<WorktreeReference> {
    try {
      await this.load();
      const name = this.worktreeName(owner);
      const binding = name ? await this.borrowedWorktree(name) : undefined;
      if (binding) {
        const resolved = await this.resolveBorrowedWorktree(binding, new Set([this.runId]));
        if (cwd !== undefined && resolve(cwd) !== resolve(resolved.reference.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
        return resolved.reference;
      }
      return await this.ownedWorktree(owner, cwd);
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async worktree(owner: string): Promise<WorktreeReference> {
    const write = this.worktreeWrite.then(async () => {
      const loaded = await this.load();
      const recordsPath = join(this.directory, "worktrees.json");
      const rawRecords = await json(recordsPath).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
      let records = decodeWorktreeReferences(rawRecords);
      if (!records) throw new WorkflowError("WORKTREE_FAILED", "Worktree records are invalid");
      const name = this.worktreeName(owner);
      const binding = name ? await this.borrowedWorktree(name) : undefined;
      if (binding) return (await this.resolveBorrowedWorktree(binding, new Set([this.runId]))).reference;
      if (name && loaded.run.parentRunId !== undefined) {
        const resolved = await this.resolveNamedWorktreeFromParent(name, loaded.run.parentRunId);
        if (resolved) {
          await this.bindBorrowedWorktree({ name, sourceRunId: resolved.sourceRunId, owner: resolved.owner });
          return resolved.reference;
        }
      }
      if (name && Array.isArray(loaded.run.retry?.namedWorktrees) && loaded.run.retry.namedWorktrees.includes(name)) throw new WorkflowError("WORKTREE_FAILED", `Missing inherited named worktree ${name}`);
      const existing = records.find((record) => record.owner === owner);
      if (existing) return this.validateWorktree(owner);
      const { path, branch } = this.expectedWorktree(owner);
      const index = join(this.directory, `index-${basename(path)}`);
      const markerPath = this.markerPath(owner);
      let branchCreated = false;
      let worktreeCreated = false;
      try {
        const root = (await git(this.cwd, ["rev-parse", "--show-toplevel"])).trim();
        const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(this.cwd)]);
        const launchRelative = relative(canonicalRoot, canonicalCwd);
        if (launchRelative === ".." || launchRelative.startsWith(`..${sep}`)) throw new Error("launch cwd is outside the repository");
        await this.cleanupMarker(markerPath);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await git(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
        await git(root, ["add", "-A"], { GIT_INDEX_FILE: index });
        const tree = (await git(root, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
        const commit = (await git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "pi-extensible-workflows runtime snapshot"], { GIT_INDEX_FILE: index, ...gitIdentity })).trim();
        const record = { owner, path, branch, cwd: join(path, launchRelative), base: commit };
        await atomicJson(markerPath, { owner, path, branch, base: commit });
        await git(root, ["branch", branch, commit]);
        branchCreated = true;
        await git(root, ["worktree", "add", "--no-checkout", path, branch]);
        worktreeCreated = true;
        await git(path, ["checkout", "--force", branch]);
        await rm(index, { force: true });
        await atomicJson(recordsPath, [...records, record]);
        await rm(markerPath, { force: true });
        return record;
      } catch (error) {
        await rm(index, { force: true });
        if (worktreeCreated) await git(this.cwd, ["worktree", "remove", "--force", path]).catch(() => undefined);
        if (branchCreated) await git(this.cwd, ["branch", "-D", branch]).catch(() => undefined);
        await rm(markerPath, { force: true });
        try {
          const persisted = decodeWorktreeReferences(await json(recordsPath));
          const match = persisted?.filter((candidate) => candidate.owner === owner);
          const candidate = match?.length === 1 ? match[0] : undefined;
          if (candidate && persisted) { this.structuralWorktree(owner, candidate); records = persisted.filter((current) => current !== candidate); await atomicJson(recordsPath, records); }
        } catch { /* Ownership changed or disappeared: do not delete anything. */ }
        throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
      }
    });
    this.worktreeWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  private async resolveNamedWorktreeFromParent(name: string, parentRunId: string): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const source = await this.sourceRun(parentRunId);
    return source.findNamedWorktree(name, new Set([this.runId]));
  }

  private async bindBorrowedWorktree(binding: BorrowedWorktreeBinding): Promise<void> {
    const write = this.borrowedWorktreeWrite.then(async () => {
      const records = [...await this.borrowedWorktreeRecords(false)];
      const existing = records.find((candidate) => candidate.name === binding.name);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(binding)) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${binding.name} changed`);
        return;
      }
      records.push(binding);
      await atomicJson(join(this.directory, "borrowed-worktrees.json"), records);
    });
    this.borrowedWorktreeWrite = write.then(() => undefined, () => undefined);
    await write;
  }
  async snapshotWorktree(owner: string): Promise<string> {
    try {
      const write = this.snapshotWrite.then(async () => {
        const record = await this.worktree(owner);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await git(record.path, ["add", "-A"]);
          if (!(await git(record.path, ["status", "--porcelain"])).trim()) break;
          try {
            await git(record.path, ["commit", "-m", "pi-extensible-workflows runtime snapshot"], gitIdentity);
            break;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
        return (await git(record.path, ["rev-parse", "HEAD"])).trim();
      });
      this.snapshotWrite = write.then(() => undefined, () => undefined);
      return await write;
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
  async worktrees(): Promise<readonly WorktreeReference[]> {
    const rawRecords = await json(join(this.directory, "worktrees.json")).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    const records = decodeWorktreeReferences(rawRecords);
    if (!records) throw new WorkflowError("WORKTREE_FAILED", "Worktree records are invalid");
    const bindings = await this.borrowedWorktreeRecords();
    const boundOwners = new Set(bindings.map((binding) => binding.owner));
    const owned = await Promise.all(records.filter((record) => !boundOwners.has(record.owner)).map(async (record) => { try { return await this.validateWorktree(record.owner); } catch { return undefined; } }));
    const borrowed = await Promise.all(bindings.map(async (binding) => (await this.resolveBorrowedWorktree(binding, new Set([this.runId]))).reference));
    return [...owned.filter((record): record is WorktreeReference => record !== undefined), ...borrowed];
  }
  async validNamedWorktrees(): Promise<readonly string[]> {
    const load = async (path: string): Promise<unknown> => {
      try { return await json(path); } catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
    };
    const names = new Set<string>();
    const rawRecords = await load(join(this.directory, "worktrees.json"));
    const records = decodeWorktreeReferences(rawRecords) ?? [];
    let bindings: readonly BorrowedWorktreeBinding[];
    try { bindings = await this.borrowedWorktreeRecords(); }
    catch (error) { if (error instanceof WorkflowError && error.code === "WORKTREE_FAILED") return []; throw error; }
    const boundOwners = new Set(bindings.map((binding) => binding.owner));
    for (const record of records) {
      const owner = record.owner;
      const name = this.worktreeName(owner);
      if (!name || owner !== this.namedWorktreeOwner(name) || boundOwners.has(owner)) continue;
      try { await this.ownedWorktree(owner); names.add(name); } catch { /* Do not advertise stale or invalid records. */ }
    }
    for (const binding of bindings) {
      try { await this.resolveBorrowedWorktree(binding, new Set([this.runId])); names.add(binding.name); } catch { /* Do not advertise stale inherited records. */ }
    }
    return [...names];
  }
  async changedWorktrees(): Promise<readonly WorktreeReference[]> {
    const changed: WorktreeReference[] = [];
    for (const valid of await this.worktrees()) {
      try { await git(valid.path, ["diff", "--quiet", valid.base, "HEAD"]); }
      catch { changed.push(valid); }
    }
    return changed;
  }

  async saveResult(value: JsonValue): Promise<string> {
    const path = join(this.directory, "result.json");
    await atomicPrettyJson(path, value);
    return path;
  }

  async resultBytes(): Promise<number> {
    return (await stat(join(this.directory, "result.json"))).size;
  }

  async delete(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new WorkflowError("CANCELLED", "Run deletion requires confirmation");
    const rawRecords = await json(join(this.directory, "worktrees.json")).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    const records = decodeWorktreeReferences(rawRecords);
    if (!records) throw new WorkflowError("WORKTREE_FAILED", "Worktree records are invalid");
    const validated = records.map((record) => {
      try { return this.structuralWorktree(record.owner, record); }
      catch (error) { throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error)); }
    });
    await this.cleanupOrphanWorktrees();
    for (const record of validated) {
      await git(this.cwd, ["worktree", "remove", "--force", record.path]).catch(() => undefined);
      await git(this.cwd, ["branch", "-D", record.branch]).catch(() => undefined);
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  return stdout;
}
