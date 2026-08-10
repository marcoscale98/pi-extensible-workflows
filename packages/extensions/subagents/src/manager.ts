import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  errorCode,
  errorText,
  isNodeError,
  jsonValue,
  loadAgentDefinitions,
  loadingRegistry,
  localAgentTransport,
  resolveAgentResourcePolicy,
  resolveWorkflowSettings,
  roleNameOf,
  structuralPath,
  validateModelAliasAvailability,
  WorkflowAgentExecutor,
  WorkflowError,
  workflowSettingsPath,
  type AgentActivity,
  type AgentAccounting,
  type AgentAttempt,
  type AgentExecutionOptions,
  type AgentExecutionResult,
  type AgentExecutionRoot,
  type AgentProgress,
  type AgentToolCallProgress,
  type JsonSchema,
  type JsonValue,
  type ModelSpec,
  type WorkflowAgentSessionState,
  type WorkflowRunContext,
} from "pi-extensible-workflows";
import {
  SUBAGENTS_TOOL_NAMES,
  normalizeSubagentRunRequest,
  type SubagentLiveness,
  type SubagentManager,
  type SubagentManagerContext,
  type SubagentManagerDependencies,
  type SubagentNotification,
  type SubagentOwnerMarker,
  type SubagentProgress,
  type SubagentRunRequest,
  type SubagentStatus,
  type SubagentUsage,
} from "./contracts.js";
import { createRunStoreWorktreeAdapter, defaultWorktreeHome, type SubagentWorktreeContext, type SubagentWorktreeHandle } from "./worktree.js";

const WORKFLOW_NAME = "subagents";
const STORAGE_DIRECTORY = "subagents";
const OWNER_FILE = "owner.json";
const OWNER_WRITE_GRACE_MS = 30_000;
const MAX_STORAGE_OWNER_ATTEMPTS = 8;
const MAX_TERMINAL_SUMMARIES = 128;
const MAX_PENDING_STEERING_MESSAGES = 16;
const SUBAGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXCLUDED_TOOLS = new Set<string>([
  ...SUBAGENTS_TOOL_NAMES,
  "workflow",
  "workflow_respond",
  "workflow_stop",
  "workflow_status",
  "workflow_resume",
  "workflow_retry",
  "workflow_catalog",
]);

type ModelIdentity = { provider: string; id: string };
type SubagentState = SubagentStatus["state"];
type SubagentFailure = { code: string; message: string };
type PersistedSubagentStatus = SubagentStatus & { startedAt: number; finishedAt?: number; owner?: SubagentOwnerMarker; worktreeContext?: SubagentWorktreeContext };
type SubagentSession = NonNullable<AgentAttempt["liveSession"]>;
type TerminalSummary = PersistedSubagentStatus;
type SteerHandler = (message: string) => void | Promise<void>;
type PersistedProgress = SubagentProgress;
type LiveRun = {
  readonly id: string;
  readonly request: Readonly<SubagentRunRequest>;
  readonly directory: string;
  readonly startedAt: number;
  readonly owner: SubagentOwnerMarker;
  readonly controller: AbortController;
  readonly promise: Promise<AgentExecutionResult>;
  state: SubagentState;
  finishedAt?: number;
  error: SubagentFailure | undefined;
  session: SubagentSession | undefined;
  progress: PersistedProgress | undefined;
  accounting: AgentAccounting | undefined;
  usage: SubagentUsage | undefined;
  activity: AgentActivity | undefined;
  toolCalls: readonly AgentToolCallProgress[] | undefined;
  lastEventAt: number | undefined;
  worktree: SubagentWorktreeHandle | undefined;
  worktreeContext: SubagentWorktreeContext | undefined;
  worktreeCleanup: Promise<void> | undefined;
  steerHandler: SteerHandler | undefined;
  pendingSteers: string[];
  steerFlush: Promise<void> | undefined;
  externalAbort: (() => void) | undefined;
  externalSignal: AbortSignal | undefined;
  sessionAbort: Promise<void> | undefined;
  sessionDispose: Promise<void> | undefined;
  executorOwnsSession: boolean;
  disposed: boolean;
  concurrencyReleased: boolean;
  notificationSent: boolean;
  writes: Promise<void>;
};
type SubagentOwnerLease = {
  readonly token: string;
  release(): Promise<void>;
};

function modelNames(models: readonly ModelIdentity[]): Set<string> {
  return new Set(models.map(({ provider, id }) => `${provider}/${id}`));
}

function rootModel(context: Readonly<SubagentManagerContext>): ModelSpec {
  const model = context.extensionContext.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) throw new WorkflowError("UNKNOWN_MODEL", "A current model is required to run a subagent");
  const thinking = context.extensionContext.thinkingLevel;
  return { provider: model.provider, model: model.id, ...(thinking === undefined ? {} : { thinking }) };
}
function executionRoot(context: Readonly<SubagentManagerContext>, dependencies: Readonly<SubagentManagerDependencies>, signal: AbortSignal, runId: string, worktree: SubagentWorktreeHandle | undefined): AgentExecutionRoot {
  const extensionContext = context.extensionContext;
  const model = rootModel(context);
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const trustedProject = extensionContext.isProjectTrusted();
  const settingsPath = workflowSettingsPath(agentDir);
  const settings = resolveWorkflowSettings(extensionContext.cwd, trustedProject, settingsPath);
  const resourcePolicy = resolveAgentResourcePolicy(extensionContext.cwd, trustedProject, settingsPath);
  const knownModels = modelNames(extensionContext.modelRegistry.getAll());
  const availableModels = modelNames(extensionContext.modelRegistry.getAvailable());
  const rootModelName = `${model.provider}/${model.model}`;
  knownModels.add(rootModelName);
  availableModels.add(rootModelName);
  const staticAliases = settings.effective.modelAliases ?? {};
  const activeTools = dependencies.getActiveTools?.() ?? [];
  const tools = new Set(activeTools.filter((tool) => !EXCLUDED_TOOLS.has(tool)));
  const sessionId = extensionContext.sessionManager.getSessionId();
  const run: WorkflowRunContext = {
    cwd: extensionContext.cwd,
    sessionId,
    runId,
    workflow: { name: WORKFLOW_NAME },
    args: null,
    signal,
  };
  const registry = loadingRegistry();
  return {
    cwd: extensionContext.cwd,
    model,
    tools,
    ...(worktree === undefined ? {} : { runStore: worktree.runStore }),
    agentDir,
    availableModels,
    knownModels,
    ...(Object.keys(staticAliases).length ? { modelAliases: staticAliases } : {}),
    settingsPath: settings.sources.modelAliases,
    agentDefinitions: loadAgentDefinitions(extensionContext.cwd, agentDir, trustedProject),
    agentSetupHooks: registry.agentSetupHooks(),
    agentResourcePolicy: () => structuredClone(resourcePolicy),
    runContext: run,
  };
}

async function addDynamicAliases(context: Readonly<SubagentManagerContext>, signal: AbortSignal, root: AgentExecutionRoot): Promise<AgentExecutionRoot> {
  const registry = loadingRegistry();
  if (registry.modelAliases().length === 0) return root;
  const staticAliases = root.modelAliases ?? {};
  const dynamicAliases = await registry.resolveModelAliases({ cwd: context.extensionContext.cwd, projectTrusted: context.extensionContext.isProjectTrusted(), rootModel: root.model, knownModels: root.knownModels ?? new Set(), availableModels: root.availableModels ?? new Set(), signal }, new Set(Object.keys(staticAliases)));
  validateModelAliasAvailability(dynamicAliases, Object.keys(dynamicAliases), root.availableModels ?? new Set(), root.knownModels ?? new Set(), root.settingsPath);
  return { ...root, modelAliases: { ...dynamicAliases, ...staticAliases } };
}

function executionOptions(request: Readonly<SubagentRunRequest>, onAttempt: NonNullable<AgentExecutionOptions["onAttempt"]>, onProgress: NonNullable<AgentExecutionOptions["onProgress"]>): AgentExecutionOptions {
  const role = request.role;
  const label = request.label ?? roleNameOf(role) ?? "subagent";
  return {
    label,
    workflowName: WORKFLOW_NAME,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking as NonNullable<AgentExecutionOptions["thinking"]> }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(role === undefined ? {} : { role: role as NonNullable<AgentExecutionOptions["role"]> }),
    ...(request.worktree === undefined ? {} : { worktreeOwner: structuralPath("worktree", "named", request.worktree) }),
    ...(request.outputSchema === undefined ? {} : { schema: request.outputSchema as JsonSchema }),
    ...(request.retries === undefined ? {} : { retries: request.retries }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    onAttempt,
    onProgress,
  };
}

function effectiveConcurrency(context: Readonly<SubagentManagerContext>, dependencies: Readonly<SubagentManagerDependencies>): number {
  return resolveWorkflowSettings(context.extensionContext.cwd, context.extensionContext.isProjectTrusted(), workflowSettingsPath(dependencies.agentDir ?? getAgentDir())).effective.concurrency;
}

function storageDirectory(dependencies: Readonly<SubagentManagerDependencies>): string {
  return dependencies.storageDir ?? join(dependencies.agentDir ?? getAgentDir(), STORAGE_DIRECTORY);
}

function runDirectory(root: string, id: string): string { return join(root, id); }
function requestPath(directory: string): string { return join(directory, "request.json"); }
function statusPath(directory: string): string { return join(directory, "status.json"); }
function resultPath(directory: string): string { return join(directory, "result.json"); }
function failurePath(directory: string): string { return join(directory, "failure.json"); }

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new WorkflowError("INTERNAL_ERROR", `Cannot serialize JSON for ${path}`);
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

async function currentProcessStart(): Promise<number> {
  if (process.platform === "linux") {
    try { return (await stat(`/proc/${String(process.pid)}`)).ctimeMs; }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
  }
  return Math.max(0, Date.now() - Math.floor(process.uptime() * 1000));
}

function decodeOwnerMarker(value: unknown): SubagentOwnerMarker | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const processStart = record.processStart;
  const sessionId = record.sessionId;
  const token = record.token;
  const acquiredAt = record.acquiredAt;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0 || !finiteNumber(processStart) || processStart < 0 || typeof sessionId !== "string" || !sessionId.trim() || typeof token !== "string" || !token.trim() || typeof acquiredAt !== "number" || !Number.isSafeInteger(acquiredAt) || acquiredAt < 0) return undefined;
  return { pid, processStart, sessionId, token, acquiredAt };
}

function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

async function createOwnerMarker(liveness: SubagentLiveness | undefined): Promise<SubagentOwnerMarker> {
  const pid = liveness?.pid ?? process.pid;
  const processStart = liveness?.processStart ?? await currentProcessStart();
  const sessionId = liveness?.sessionId ?? `${String(pid)}:${String(processStart)}`;
  const token = liveness?.token ?? randomUUID();
  if (!Number.isSafeInteger(pid) || pid < 0 || !finiteNumber(processStart) || processStart < 0 || typeof sessionId !== "string" || !sessionId.trim() || typeof token !== "string" || !token.trim()) throw new WorkflowError("INTERNAL_ERROR", "Invalid subagent storage owner identity");
  return { pid, processStart, sessionId, token, acquiredAt: Date.now() };
}

async function processAlive(pid: number, processStart: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch (error) { return !isNodeError(error, "ESRCH"); }
  if (process.platform === "linux") {
    try { if ((await stat(`/proc/${String(pid)}`)).ctimeMs > processStart) return false; }
    catch (error) { if (isNodeError(error, "ENOENT")) return false; }
  }
  return true;
}

async function ownerIsLive(owner: SubagentOwnerMarker, liveness: SubagentLiveness | undefined): Promise<boolean> {
  if (liveness?.isLive) {
    try { return await liveness.isLive(owner); }
    catch { return true; }
  }
  if (liveness?.pid !== undefined && liveness.processStart !== undefined && owner.pid === liveness.pid && owner.processStart === liveness.processStart) return true;
  return processAlive(owner.pid, owner.processStart);
}

async function restoreOwnerMarker(path: string, stale: string): Promise<void> {
  try { await link(stale, path); }
  catch (error) { if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOENT")) throw error; }
  await rm(stale, { force: true });
}

async function writeOwnerMarker(path: string, marker: SubagentOwnerMarker): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true });
    throw error;
  }
}

async function releaseOwnerMarker(path: string, token: string): Promise<void> {
  let marker: SubagentOwnerMarker | undefined;
  try { marker = decodeOwnerMarker(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    // A malformed or replaced marker cannot prove this manager still owns the storage.
    return;
  }
  if (marker?.token === token) await rm(path, { force: true });
}

async function acquireStorageOwner(root: string, owner: SubagentOwnerMarker, liveness: SubagentLiveness | undefined): Promise<SubagentOwnerLease | undefined> {
  await secureDirectory(root);
  const path = join(root, OWNER_FILE);
  for (let attempt = 0; attempt < MAX_STORAGE_OWNER_ATTEMPTS; attempt += 1) {
    const marker: SubagentOwnerMarker = { ...owner, acquiredAt: Date.now() };
    try {
      await writeOwnerMarker(path, marker);
      return { token: marker.token, release: () => releaseOwnerMarker(path, marker.token) };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    let existingText: string;
    try { existingText = await readFile(path, "utf8"); }
    catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
    let existing: SubagentOwnerMarker | undefined;
    try { existing = decodeOwnerMarker(JSON.parse(existingText)); }
    catch { existing = undefined; }
    if (existing) {
      if (await ownerIsLive(existing, liveness)) return undefined;
    } else {
      let age: number;
      try { age = Math.max(0, Date.now() - (await stat(path)).mtimeMs); }
      catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
      if (age < OWNER_WRITE_GRACE_MS) return undefined;
    }
    const stale = `${path}.${randomUUID()}.stale`;
    try { await rename(path, stale); }
    catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
    let movedText: string;
    try { movedText = await readFile(stale, "utf8"); }
    catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
    const moved = (() => { try { return decodeOwnerMarker(JSON.parse(movedText)); } catch { return undefined; } })();
    const same = existing ? moved?.token === existing.token : movedText === existingText;
    if (!same) { await restoreOwnerMarker(path, stale); continue; }
    await rm(stale, { force: true });
  }
  return undefined;
}

function validSubagentId(id: string): boolean { return SUBAGENT_ID_PATTERN.test(id); }

function checkedRequest(request: unknown): SubagentRunRequest {
  return normalizeSubagentRunRequest(request);
}

function checkedId(request: Readonly<{ id: string }>): string {
  if (typeof request.id !== "string" || !validSubagentId(request.id)) throw new WorkflowError("RUN_NOT_FOUND", `Unknown subagent ${request.id}`);
  return request.id;
}

function failureFrom(error: unknown): SubagentFailure {
  return { code: errorCode(error) ?? "AGENT_FAILED", message: errorText(error) };
}

function internalStorageError(error: unknown, operation: string): WorkflowError {
  return new WorkflowError("INTERNAL_ERROR", `${operation}: ${errorText(error)}`);
}

function usageFromAccounting(accounting: AgentAccounting): SubagentUsage {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return { tokens: { input: accounting.input, output: accounting.output, cacheRead: accounting.cacheRead, cacheWrite: accounting.cacheWrite, total }, cost: accounting.cost };
}
function statusFields(run: LiveRun): Pick<SubagentStatus, "progress" | "activity" | "usage" | "toolCalls" | "accounting" | "lastEventAt"> {
  const accounting = run.accounting ?? run.progress?.accounting;
  const usage = run.usage ?? (accounting === undefined ? undefined : usageFromAccounting(accounting));
  return {
    ...(run.progress === undefined ? {} : { progress: structuredClone(run.progress) }),
    ...(run.activity === undefined ? {} : { activity: structuredClone(run.activity) }),
    ...(usage === undefined ? {} : { usage: structuredClone(usage) }),
    ...(run.toolCalls === undefined ? {} : { toolCalls: structuredClone(run.toolCalls) }),
    ...(accounting === undefined ? {} : { accounting: structuredClone(accounting) }),
    ...(run.lastEventAt === undefined ? {} : { lastEventAt: run.lastEventAt }),
  };
}
function withoutOwner(status: PersistedSubagentStatus): PersistedSubagentStatus {
  const next = { ...status };
  delete next.owner;
  return next;
}
function persistedStatus(run: LiveRun): PersistedSubagentStatus {
  const status: PersistedSubagentStatus = {
    id: run.id,
    state: run.state,
    startedAt: run.startedAt,
    owner: { ...run.owner },
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.worktree === undefined ? {} : { worktree: { path: run.worktree.path, branch: run.worktree.branch } }),
    ...(run.worktreeContext === undefined ? {} : { worktreeContext: { ...run.worktreeContext } }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...statusFields(run),
  };
  return run.state === "running" ? status : withoutOwner(status);
}

function decodeFailure(value: unknown): SubagentFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as { message?: unknown };
  const code = errorCode(value);
  return code && typeof record.message === "string" ? { code, message: record.message } : undefined;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function accountingValue(value: unknown): AgentAccounting | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const names = ["input", "output", "cacheRead", "cacheWrite", "cost"];
  if (names.some((name) => !finite(record[name]))) return undefined;
  return { input: record.input as number, output: record.output as number, cacheRead: record.cacheRead as number, cacheWrite: record.cacheWrite as number, cost: record.cost as number };
}
function activityValue(value: unknown): AgentActivity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return (record.kind === "reasoning" || record.kind === "tool" || record.kind === "text") && typeof record.text === "string" ? { kind: record.kind, text: record.text } : undefined;
}
function toolCallsValue(value: unknown): readonly AgentToolCallProgress[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: AgentToolCallProgress[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || (record.state !== "running" && record.state !== "completed" && record.state !== "failed")) return undefined;
    calls.push({ id: record.id, name: record.name, state: record.state });
  }
  return calls;
}
function sessionStateValue(value: unknown): WorkflowAgentSessionState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const model = record.model;
  if (typeof model !== "object" || model === null || Array.isArray(model)) return undefined;
  const modelRecord = model as Record<string, unknown>;
  const rawTools = record.tools;
  if (typeof modelRecord.provider !== "string" || typeof modelRecord.model !== "string" || !Array.isArray(rawTools)) return undefined;
  const tools = rawTools.filter((tool): tool is string => typeof tool === "string");
  if (tools.length !== rawTools.length) return undefined;
  if (record.thinking !== undefined && typeof record.thinking !== "string") return undefined;
  if (record.systemPrompt !== undefined && typeof record.systemPrompt !== "string") return undefined;
  return { model: { provider: modelRecord.provider, model: modelRecord.model, ...(typeof record.thinking === "string" ? { thinking: record.thinking as NonNullable<WorkflowAgentSessionState["thinking"]> } : {}) }, ...(typeof record.thinking === "string" ? { thinking: record.thinking as NonNullable<WorkflowAgentSessionState["thinking"]> } : {}), tools, ...(typeof record.systemPrompt === "string" ? { systemPrompt: record.systemPrompt } : {}) };
}
function usageValue(value: unknown): SubagentUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tokens = record.tokens;
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return undefined;
  const tokenRecord = tokens as Record<string, unknown>;
  const names = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (names.some((name) => !finite(tokenRecord[name])) || !finite(record.cost)) return undefined;
  const input = tokenRecord.input;
  const output = tokenRecord.output;
  const cacheRead = tokenRecord.cacheRead;
  const cacheWrite = tokenRecord.cacheWrite;
  const total = tokenRecord.total;
  const cost = record.cost;
  if (!finite(input) || !finite(output) || !finite(cacheRead) || !finite(cacheWrite) || !finite(total) || !finite(cost)) return undefined;
  return { tokens: { input, output, cacheRead, cacheWrite, total }, cost };
}
function progressValue(value: unknown): SubagentProgress | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const accounting = accountingValue(record.accounting);
  const toolCalls = toolCallsValue(record.toolCalls);
  const state = record.state === undefined ? undefined : sessionStateValue(record.state);
  if (!accounting || !toolCalls || (record.state !== undefined && state === undefined)) return undefined;
  const activity = record.activity === undefined ? undefined : activityValue(record.activity);
  if (record.activity !== undefined && activity === undefined) return undefined;
  if (record.lastEventAt !== undefined && (!Number.isSafeInteger(record.lastEventAt) || (record.lastEventAt as number) < 0)) return undefined;
  return { accounting, toolCalls, ...(state === undefined ? {} : { state }), ...(activity === undefined ? {} : { activity }), ...(record.lastEventAt === undefined ? {} : { lastEventAt: record.lastEventAt as number }) };
}
function worktreeValue(value: unknown): { path: string; branch: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && record.path.trim() && typeof record.branch === "string" && record.branch.trim() ? { path: record.path, branch: record.branch } : undefined;
}
function worktreeContextValue(value: unknown): SubagentWorktreeContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const context = typeof record.cwd === "string" && typeof record.sessionId === "string" && typeof record.runId === "string" && typeof record.name === "string" && typeof record.owner === "string" ? { cwd: record.cwd, sessionId: record.sessionId, runId: record.runId, name: record.name, owner: record.owner } : undefined;
  if (!context || !context.cwd.trim() || !context.sessionId.trim() || !context.runId.trim() || !context.name.trim() || !context.owner.trim()) return undefined;
  return context;
}
function decodeStatus(value: unknown, id: string): PersistedSubagentStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.id !== id || !validSubagentId(id) || (record.state !== "running" && record.state !== "completed" && record.state !== "failed" && record.state !== "stopped") || typeof record.startedAt !== "number" || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0) return undefined;
  const owner = record.owner === undefined ? undefined : decodeOwnerMarker(record.owner);
  if (record.owner !== undefined && owner === undefined) return undefined;
  const error = record.error === undefined ? undefined : decodeFailure(record.error);
  if (record.error !== undefined && error === undefined) return undefined;
  if (record.finishedAt !== undefined && (typeof record.finishedAt !== "number" || !Number.isSafeInteger(record.finishedAt) || record.finishedAt < record.startedAt)) return undefined;
  const worktree = record.worktree === undefined ? undefined : worktreeValue(record.worktree);
  const worktreeContext = record.worktreeContext === undefined ? undefined : worktreeContextValue(record.worktreeContext);
  if (record.worktree !== undefined && worktree === undefined || record.worktreeContext !== undefined && worktreeContext === undefined) return undefined;
  if (worktreeContext && (worktreeContext.runId !== id || worktreeContext.owner !== structuralPath("worktree", "named", worktreeContext.name))) return undefined;
  const progress = record.progress === undefined ? undefined : progressValue(record.progress);
  if (record.progress !== undefined && progress === undefined) return undefined;
  const activity = record.activity === undefined ? undefined : activityValue(record.activity);
  const toolCalls = record.toolCalls === undefined ? undefined : toolCallsValue(record.toolCalls);
  const accounting = record.accounting === undefined ? undefined : accountingValue(record.accounting);
  const usage = record.usage === undefined ? undefined : usageValue(record.usage);
  if ((record.activity !== undefined && activity === undefined) || (record.toolCalls !== undefined && toolCalls === undefined) || (record.accounting !== undefined && accounting === undefined) || (record.usage !== undefined && usage === undefined)) return undefined;
  if (record.lastEventAt !== undefined && (!Number.isSafeInteger(record.lastEventAt) || (record.lastEventAt as number) < 0)) return undefined;
  return { id, state: record.state, startedAt: record.startedAt, ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }), ...(owner === undefined ? {} : { owner }), ...(worktree === undefined ? {} : { worktree }), ...(worktreeContext === undefined ? {} : { worktreeContext }), ...(error === undefined ? {} : { error }), ...(progress === undefined ? {} : { progress }), ...(activity === undefined ? {} : { activity }), ...(usage === undefined ? {} : { usage }), ...(toolCalls === undefined ? {} : { toolCalls }), ...(accounting === undefined ? {} : { accounting }), ...(record.lastEventAt === undefined ? {} : { lastEventAt: record.lastEventAt as number }) };
}
function publicStatus(status: SubagentStatus): SubagentStatus {
  return {
    id: status.id,
    state: status.state,
    ...(status.worktree === undefined ? {} : { worktree: { ...status.worktree } }),
    ...(status.error === undefined ? {} : { error: { ...status.error } }),
    ...(status.progress === undefined ? {} : { progress: structuredClone(status.progress) }),
    ...(status.activity === undefined ? {} : { activity: structuredClone(status.activity) }),
    ...(status.usage === undefined ? {} : { usage: structuredClone(status.usage) }),
    ...(status.toolCalls === undefined ? {} : { toolCalls: structuredClone(status.toolCalls) }),
    ...(status.accounting === undefined ? {} : { accounting: structuredClone(status.accounting) }),
    ...(status.lastEventAt === undefined ? {} : { lastEventAt: status.lastEventAt }),
  };
}

async function createRunStorage(root: string, id: string, request: Readonly<SubagentRunRequest>, status: PersistedSubagentStatus): Promise<string> {
  await secureDirectory(root);
  const directory = runDirectory(root, id);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await chmod(directory, 0o700);
    await atomicJson(requestPath(directory), request);
    await atomicJson(statusPath(directory), status);
    return directory;
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function loadPersistedStatus(root: string, id: string): Promise<PersistedSubagentStatus> {
  try {
    const value = await readJson(statusPath(runDirectory(root, id)));
    const status = decodeStatus(value, id);
    if (!status) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent status is invalid");
    return status;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new WorkflowError("RUN_NOT_FOUND", `Unknown subagent ${id}`);
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} status`);
  }
}
async function loadPersistedRequest(root: string, id: string): Promise<SubagentRunRequest> {
  try {
    return checkedRequest(await readJson(requestPath(runDirectory(root, id))));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} request`);
  }
}

async function loadPersistedFailure(root: string, id: string): Promise<SubagentFailure> {
  try {
    const failure = decodeFailure(await readJson(failurePath(runDirectory(root, id))));
    if (!failure) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent failure is invalid");
    return failure;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} failure`);
  }
}

async function loadPersistedResult(root: string, id: string): Promise<JsonValue> {
  try {
    const value = await readJson(resultPath(runDirectory(root, id)));
    if (!jsonValue(value)) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent result is not a JSON value");
    return value;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} result`);
  }
}

async function loadOptionalJson(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function orphanedFailure(): SubagentFailure {
  return { code: "INTERNAL_ERROR", message: "Subagent run was interrupted before completion" };
}

function reconciledStatus(status: PersistedSubagentStatus, state: Exclude<SubagentState, "running">, finishedAt: number, error?: SubagentFailure): PersistedSubagentStatus {
  const next: PersistedSubagentStatus = {
    ...status,
    state,
    finishedAt,
    ...(error === undefined ? {} : { error }),
  };
  return withoutOwner(next);
}

function withoutWorktree(status: PersistedSubagentStatus): PersistedSubagentStatus {
  const next = { ...status };
  delete next.worktree;
  delete next.worktreeContext;
  return next;
}

async function reconcilePersistedResult(root: string, id: string, status: PersistedSubagentStatus): Promise<PersistedSubagentStatus> {
  if (status.state !== "running") return status;
  const directory = runDirectory(root, id);
  const result = await loadOptionalJson(resultPath(directory));
  if (result === undefined) return status;
  if (!jsonValue(result)) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent result is not a JSON value");
  const completed = reconciledStatus(status, "completed", Math.max(Date.now(), status.startedAt));
  await atomicJson(statusPath(directory), completed);
  return completed;
}

async function reconcilePersistedRun(root: string, id: string, status: PersistedSubagentStatus): Promise<PersistedSubagentStatus> {
  const afterResult = await reconcilePersistedResult(root, id, status);
  if (afterResult.state !== "running") return afterResult;
  const directory = runDirectory(root, id);
  const failureValue = await loadOptionalJson(failurePath(directory));
  const failure = failureValue === undefined ? orphanedFailure() : decodeFailure(failureValue);
  if (!failure) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent failure is invalid");
  const failed = reconciledStatus(afterResult, "failed", Math.max(Date.now(), afterResult.startedAt), failure);
  await atomicJson(failurePath(directory), failure);
  await atomicJson(statusPath(directory), failed);
  return failed;
}

type InterruptedWorktreeCleanup = (root: string, id: string, status: PersistedSubagentStatus) => Promise<boolean>;
async function persistReconciliationFailure(root: string, id: string, status: PersistedSubagentStatus, error: unknown): Promise<void> {
  if (status.state !== "running") return;
  let persisted: PersistedSubagentStatus;
  try { persisted = await loadPersistedStatus(root, id); }
  catch { return; }
  if (persisted.state !== "running") return;
  const failure = failureFrom(error);
  const failed = reconciledStatus(persisted, "failed", Math.max(Date.now(), persisted.startedAt), failure);
  try {
    await atomicJson(statusPath(runDirectory(root, id)), failed);
  } catch {
    // A run without a writable status file stays isolated from healthy records.
    return;
  }
  try {
    await atomicJson(failurePath(runDirectory(root, id)), failure);
  } catch {
    // The terminal status retains the recovery failure when its detail file cannot be written.
  }
}
async function reconcilePersistedRuns(root: string, liveness: SubagentLiveness | undefined, cleanupWorktree?: InterruptedWorktreeCleanup): Promise<void> {
  await secureDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !validSubagentId(entry.name)) continue;
    let status: PersistedSubagentStatus;
    try {
      status = await loadPersistedStatus(root, entry.name);
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "RUN_NOT_FOUND") continue;
      // A malformed status cannot be safely rewritten; keep other runs available.
      continue;
    }
    if (status.state !== "running" && status.worktreeContext === undefined && status.worktree === undefined) continue;
    if (status.state === "running" && status.owner !== undefined && await ownerIsLive(status.owner, liveness)) continue;
    try {
      if (status.state === "running") status = await reconcilePersistedResult(root, entry.name, status);
      let cleaned = false;
      if (status.worktreeContext !== undefined && cleanupWorktree !== undefined) {
        cleaned = await cleanupWorktree(root, entry.name, status);
      }
      if (status.state === "running") status = await reconcilePersistedRun(root, entry.name, status);
      if (cleaned || (status.worktreeContext === undefined && status.worktree !== undefined)) {
        status = withoutOwner(withoutWorktree(status));
        await atomicJson(statusPath(runDirectory(root, entry.name)), status);
      }
    } catch (error) {
      await persistReconciliationFailure(root, entry.name, status, error);
    }
  }
}

function enqueueWrite(run: LiveRun, operation: () => Promise<void>): Promise<void> {
  const write = run.writes.then(operation);
  run.writes = write.catch(() => undefined);
  return write;
}

function terminalSummary(run: LiveRun): TerminalSummary {
  return persistedStatus(run);
}

function unavailable(operation: string): { ok: false; error: { code: "SUBAGENTS_NOT_CONFIGURED"; message: string } } {
  return { ok: false, error: { code: "SUBAGENTS_NOT_CONFIGURED", message: `Subagent manager does not implement ${operation} yet.` } };
}

class PersistentSubagentManager implements SubagentManager {
  private readonly activeRuns = new Map<string, LiveRun>();
  private activeRunCount = 0;
  private readonly terminalSummaries = new Map<string, TerminalSummary>();
  private readonly notificationPromises = new Set<Promise<void>>();
  private readonly initialization: Promise<void>;
  private readonly worktreeAdapter: NonNullable<SubagentManagerDependencies["worktreeAdapter"]>;
  private initializationError: WorkflowError | undefined;
  private storageOwner: SubagentOwnerLease | undefined;
  private runOwner: SubagentOwnerMarker | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: Readonly<SubagentManagerDependencies>) {
    this.worktreeAdapter = dependencies.worktreeAdapter ?? createRunStoreWorktreeAdapter(defaultWorktreeHome(storageDirectory(dependencies)));
    this.initialization = this.initialize();
  }
  private async initialize(): Promise<void> {
    try {
      const owner = await createOwnerMarker(this.dependencies.liveness);
      this.runOwner = owner;
      this.storageOwner = await acquireStorageOwner(storageDirectory(this.dependencies), owner, this.dependencies.liveness);
      if (!this.storageOwner) return;
      const cleanup = this.worktreeAdapter.cleanup?.bind(this.worktreeAdapter);
      await reconcilePersistedRuns(storageDirectory(this.dependencies), this.dependencies.liveness, async (_root, _id, status) => {
        const worktreeContext = status.worktreeContext;
        if (!cleanup || !worktreeContext) return false;
        await cleanup(worktreeContext);
        return true;
      });
    } catch (error: unknown) {
      this.initializationError = error instanceof WorkflowError ? error : internalStorageError(error, "Unable to reconcile subagent storage");
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialization;
    if (this.initializationError) throw this.initializationError;
  }
  async run(request: Readonly<SubagentRunRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown> {
    return this.start(checkedRequest(request), context);
  }

  private async start(snapshot: SubagentRunRequest, context: Readonly<SubagentManagerContext>): Promise<unknown> {
    await this.ensureInitialized();
    if (this.disposed) throw new WorkflowError("CANCELLED", "Subagent manager is disposed");
    if (context.signal?.aborted) throw new WorkflowError("CANCELLED", "Subagent cancelled");
    const id = randomUUID();
    const startedAt = Date.now();
    const owner = this.runOwner;
    if (!owner) throw new WorkflowError("INTERNAL_ERROR", "Subagent storage owner identity is unavailable");
    const concurrency = effectiveConcurrency(context, this.dependencies);
    if (this.activeRunCount >= concurrency) throw new WorkflowError("AGENT_FAILED", `Subagent concurrency limit reached (${String(this.activeRunCount)}/${String(concurrency)} active runs); no queue is maintained. Retry after an active run settles.`);
    this.activeRunCount += 1;
    const controller = new AbortController();
    const initialStatus: PersistedSubagentStatus = { id, state: "running", startedAt, owner: { ...owner } };
    let directory: string;
    try {
      directory = await createRunStorage(storageDirectory(this.dependencies), id, snapshot, initialStatus);
    } catch (error) {
      this.activeRunCount -= 1;
      if (error instanceof WorkflowError) throw error;
      throw internalStorageError(error, `Unable to start subagent ${id}`);
    }
    const current: { run?: LiveRun } = {};
    const executorOwnership = { default: true };
    const execution = Promise.resolve().then(async () => {
      const live = current.run;
      if (!live || live.disposed || controller.signal.aborted) throw new WorkflowError("CANCELLED", "Subagent cancelled");
      const worktreeContext = snapshot.worktree === undefined ? undefined : {
        cwd: context.extensionContext.cwd,
        sessionId: context.extensionContext.sessionManager.getSessionId(),
        runId: id,
        name: snapshot.worktree,
        owner: structuralPath("worktree", "named", snapshot.worktree),
      };
      if (worktreeContext !== undefined) {
        live.worktreeContext = worktreeContext;
        await enqueueWrite(live, () => atomicJson(statusPath(live.directory), persistedStatus(live)));
      }
      const worktree = worktreeContext === undefined ? undefined : await this.worktreeAdapter.create(worktreeContext);
      if (worktree) {
        live.worktree = worktree;
        await enqueueWrite(live, () => atomicJson(statusPath(live.directory), persistedStatus(live)));
        if (!this.canSteer(live)) {
          await this.cleanupWorktree(live);
          throw new WorkflowError("CANCELLED", "Subagent cancelled");
        }
      }
      const baseRoot = executionRoot(context, this.dependencies, controller.signal, id, worktree);
      const root = loadingRegistry().modelAliases().length === 0 ? baseRoot : await addDynamicAliases(context, controller.signal, baseRoot);
      const transport = this.dependencies.transport ?? localAgentTransport;
      const injectedExecutor = this.dependencies.createExecutor?.(root, transport);
      executorOwnership.default = injectedExecutor === undefined;
      if (current.run) current.run.executorOwnsSession = executorOwnership.default;
      const setSteer = (handler: SteerHandler): void => {
        const run = current.run;
        if (run) this.registerSteerHandler(run, handler);
      };
      const options = executionOptions(snapshot, (attempt) => {
        const run = current.run;
        if (!run || run.disposed) return;
        if (attempt.liveSession) {
          run.session = attempt.liveSession;
          if (run.controller.signal.aborted) void this.cleanupSession(run, !run.executorOwnsSession).catch(() => undefined);
        }
        this.recordAttemptAccounting(run, attempt.accounting);
      }, (progress) => this.recordProgress(current.run, progress));
      if (injectedExecutor) return injectedExecutor.execute(snapshot.prompt, options, controller.signal, setSteer);
      return new WorkflowAgentExecutor(root, transport).execute(snapshot.prompt, options, controller.signal, [], setSteer);
    });
    const run: LiveRun = { id, request: snapshot, directory, startedAt, owner: { ...owner }, controller, promise: execution, state: "running", error: undefined, session: undefined, progress: undefined, accounting: undefined, usage: undefined, activity: undefined, toolCalls: undefined, lastEventAt: undefined, worktree: undefined, worktreeContext: undefined, worktreeCleanup: undefined, steerHandler: undefined, pendingSteers: [], steerFlush: undefined, externalAbort: undefined, externalSignal: undefined, sessionAbort: undefined, sessionDispose: undefined, executorOwnsSession: executorOwnership.default, disposed: false, concurrencyReleased: false, notificationSent: false, writes: Promise.resolve() };
    current.run = run;
    this.activeRuns.set(id, run);
    const externalSignal = context.signal;
    if (externalSignal) {
      const abort = () => { this.abortRun(run); };
      run.externalAbort = abort;
      run.externalSignal = externalSignal;
      externalSignal.addEventListener("abort", abort, { once: true });
      if (externalSignal.aborted) this.abortRun(run);
    }
    this.observe(run);
    return { id, state: "running" };
  }

  async status(request: Readonly<{ id: string }>): Promise<unknown> {
    const id = checkedId(request);
    await this.ensureInitialized();
    const active = this.activeRuns.get(id);
    if (active) return publicStatus(persistedStatus(active));
    const summary = this.terminalSummaries.get(id);
    if (summary) return publicStatus(summary);
    return publicStatus(await loadPersistedStatus(storageDirectory(this.dependencies), id));
  }

  async result(request: Readonly<{ id: string }>): Promise<unknown> {
    const id = checkedId(request);
    await this.ensureInitialized();
    const active = this.activeRuns.get(id);
    const status = active ? persistedStatus(active) : this.terminalSummaries.get(id) ?? await loadPersistedStatus(storageDirectory(this.dependencies), id);
    if (status.state === "running") return { id, state: "running" };
    if (status.state === "stopped") return { id, state: "stopped" };
    if (status.state === "failed") {
      const failure = status.error ?? await loadPersistedFailure(storageDirectory(this.dependencies), id);
      return { id, error: { ...failure } };
    }
    return { id, value: await loadPersistedResult(storageDirectory(this.dependencies), id) };
  }

  async list(): Promise<unknown> {
    await this.ensureInitialized();
    const root = storageDirectory(this.dependencies);
    await secureDirectory(root);
    const entries = await readdir(root, { withFileTypes: true });
    const statuses: PersistedSubagentStatus[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validSubagentId(entry.name)) continue;
      try {
        const active = this.activeRuns.get(entry.name);
        if (active) {
          statuses.push(persistedStatus(active));
          continue;
        }
        const status = await loadPersistedStatus(root, entry.name);
        statuses.push(this.terminalSummaries.get(entry.name) ?? status);
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "RUN_NOT_FOUND") continue;
        throw error;
      }
    }
    statuses.sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return statuses.map(publicStatus);
  }

  async steer(request: Readonly<{ id: string; message: string }>): Promise<unknown> {
    const id = checkedId(request);
    if (typeof request.message !== "string") throw new WorkflowError("INVALID_METADATA", "Invalid subagents_steer parameters");
    await this.ensureInitialized();
    const run = this.activeRuns.get(id);
    if (!run || !this.canSteer(run)) throw new WorkflowError("AGENT_FAILED", `Subagent ${id} is not running`);
    if (run.pendingSteers.length + (run.steerFlush === undefined ? 0 : 1) >= MAX_PENDING_STEERING_MESSAGES) throw new WorkflowError("AGENT_FAILED", `Steering queue is full for subagent ${id}`);
    run.pendingSteers.push(request.message);
    this.flushSteers(run);
    return { id, accepted: true };
  }

  async stop(request: Readonly<{ id: string }>): Promise<unknown> {
    const id = checkedId(request);
    await this.ensureInitialized();
    const run = this.activeRuns.get(id);
    if (!run) return publicStatus(await loadPersistedStatus(storageDirectory(this.dependencies), id));
    if (run.state !== "running") return publicStatus(persistedStatus(run));
    await this.stopRun(run, false);
    return publicStatus(persistedStatus(run));
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      await this.initialization;
      this.disposed = true;
      const runs = [...this.activeRuns.values()];
      await Promise.allSettled(runs.map((run) => this.stopRun(run, true)));
      await Promise.allSettled([...this.notificationPromises]);
      const owner = this.storageOwner;
      this.storageOwner = undefined;
      await owner?.release();
    })();
    return this.disposePromise;
  }

  async retry(request: Readonly<{ id: string }>, context: Readonly<SubagentManagerContext>): Promise<unknown> {
    const id = checkedId(request);
    await this.ensureInitialized();
    const active = this.activeRuns.get(id);
    const status = active ? persistedStatus(active) : this.terminalSummaries.get(id) ?? await loadPersistedStatus(storageDirectory(this.dependencies), id);
    if (status.state !== "failed" && status.state !== "stopped") throw new WorkflowError("AGENT_FAILED", `Subagent ${id} is not retryable`);
    return this.start(await loadPersistedRequest(storageDirectory(this.dependencies), id), context);
  }

  private releaseConcurrency(run: LiveRun): void {
    if (run.concurrencyReleased) return;
    run.concurrencyReleased = true;
    this.activeRunCount -= 1;
  }

  private canSteer(run: LiveRun): boolean {
    return !run.disposed && run.state === "running" && !run.controller.signal.aborted;
  }
  private terminalOrDisposed(run: LiveRun): boolean { return run.disposed || run.state === "stopped"; }

  private registerSteerHandler(run: LiveRun, handler: SteerHandler): void {
    if (!this.canSteer(run)) {
      run.pendingSteers.length = 0;
      return;
    }
    run.steerHandler = handler;
    this.flushSteers(run);
  }

  private flushSteers(run: LiveRun): void {
    if (!run.steerHandler || run.steerFlush || run.disposed) return;
    const flush = (async () => {
      while (run.pendingSteers.length > 0) {
        if (!this.canSteer(run)) {
          run.pendingSteers.length = 0;
          return;
        }
        const message = run.pendingSteers.shift();
        const handler = run.steerHandler;
        if (message === undefined || !handler) {
          if (message !== undefined) run.pendingSteers.unshift(message);
          return;
        }
        try {
          const result = handler(message);
          if (result && typeof result === "object" && "then" in result && typeof result.then === "function") await result;
        } catch {
          run.steerHandler = undefined;
          run.pendingSteers.length = 0;
          return;
        }
      }
    })();
    run.steerFlush = flush;
    void flush.then(() => {
      if (run.steerFlush === flush) run.steerFlush = undefined;
      if (this.canSteer(run) && run.steerHandler && run.pendingSteers.length > 0) this.flushSteers(run);
    }, () => {
      if (run.steerFlush === flush) run.steerFlush = undefined;
      run.pendingSteers.length = 0;
    });
  }

  private abortRun(run: LiveRun): void {
    if (run.disposed || run.state !== "running") return;
    run.controller.abort();
    this.clearSteering(run);
    void this.cleanupSession(run, false).catch(() => undefined);
  }

  private clearSteering(run: LiveRun): void {
    run.steerHandler = undefined;
    run.pendingSteers.length = 0;
  }

  private async recordProgress(run: LiveRun | undefined, progress: AgentProgress): Promise<void> {
    if (!run || !this.canSteer(run)) return;
    const snapshot: PersistedProgress = {
      accounting: structuredClone(progress.accounting),
      toolCalls: structuredClone(progress.toolCalls),
      ...(progress.state === undefined ? {} : { state: structuredClone(progress.state) }),
      ...(progress.activity === undefined ? {} : { activity: structuredClone(progress.activity) }),
      ...(progress.lastEventAt === undefined ? {} : { lastEventAt: progress.lastEventAt }),
    };
    run.progress = snapshot;
    run.accounting = structuredClone(progress.accounting);
    run.usage = usageFromAccounting(progress.accounting);
    run.activity = progress.activity === undefined ? undefined : structuredClone(progress.activity);
    run.toolCalls = structuredClone(progress.toolCalls);
    run.lastEventAt = progress.lastEventAt;
    if (!progress.persist) return;
    await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
  }

  private recordAttemptAccounting(run: LiveRun, value: unknown): void {
    const accounting = accountingValue(value);
    if (!accounting) return;
    run.accounting = accounting;
    run.usage = usageFromAccounting(accounting);
  }

  private async stopRun(run: LiveRun, disposeSession: boolean): Promise<void> {
    if (run.state === "running") {
      run.state = "stopped";
      this.releaseConcurrency(run);
      run.finishedAt = Date.now();
      const sessionCleanup = this.cleanupSession(run, disposeSession);
      run.controller.abort();
      this.clearSteering(run);
      this.removeExternalAbort(run);
      let statusError: unknown;
      try {
        await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
      } catch (error) {
        statusError = error;
      }
      const cleanupErrors = await sessionCleanup;
      let worktreeError: unknown;
      let worktreeCleaned = false;
      try {
        worktreeCleaned = await this.cleanupWorktree(run);
      } catch (error) {
        worktreeError = error;
      }
      if (worktreeCleaned) {
        try {
          await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
        } catch (error) {
          statusError ??= error;
        }
      }
      if (disposeSession) {
        run.disposed = true;
        this.removeLiveRun(run);
      }
      if (statusError) throw internalStorageError(statusError, `Unable to stop subagent ${run.id}`);
      if (cleanupErrors.length > 0) throw new WorkflowError("INTERNAL_ERROR", `Unable to stop subagent ${run.id}: ${errorText(cleanupErrors[0])}`);
      if (worktreeError) throw new WorkflowError("WORKTREE_FAILED", `Unable to clean up subagent ${run.id} worktree: ${errorText(worktreeError)}`);
      return;
    }
    if (disposeSession) {
      run.disposed = true;
      this.clearSteering(run);
      await this.cleanupSession(run, true);
      const worktreeCleaned = await this.cleanupWorktree(run);
      if (worktreeCleaned) await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
      this.removeLiveRun(run);
    }
  }

  private async cleanupSession(run: LiveRun, dispose: boolean, abort = true): Promise<unknown[]> {
    const session = run.session;
    if (!session) return [];
    const errors: unknown[] = [];
    if (abort) {
      if (!run.sessionAbort) run.sessionAbort = Promise.resolve().then(() => session.abort());
      await run.sessionAbort.then(() => undefined, (error: unknown) => { errors.push(error); });
    }
    if (dispose) {
      if (!run.sessionDispose) run.sessionDispose = Promise.resolve().then(() => session.dispose());
      await run.sessionDispose.then(() => undefined, (error: unknown) => { errors.push(error); });
      run.session = undefined;
    }
    return errors;
  }
  private async cleanupWorktree(run: LiveRun): Promise<boolean> {
    const worktree = run.worktree;
    let cleanup = run.worktreeCleanup;
    if (cleanup === undefined) {
      if (!worktree || run.worktreeContext === undefined) return false;
      cleanup = Promise.resolve().then(() => worktree.cleanup());
      run.worktreeCleanup = cleanup;
    }
    await cleanup;
    run.worktree = undefined;
    run.worktreeContext = undefined;
    return true;
  }

  private removeExternalAbort(run: LiveRun): void {
    const listener = run.externalAbort;
    const signal = run.externalSignal;
    if (listener && signal) signal.removeEventListener("abort", listener);
    run.externalAbort = undefined;
    run.externalSignal = undefined;
  }

  private observe(run: LiveRun): void {
    void run.promise.then(
      (result) => this.settleSuccess(run, result),
      (error: unknown) => this.settleFailure(run, error),
    ).catch((error: unknown) => this.settleFailure(run, error)).catch(() => undefined);
  }

  private async settleSuccess(run: LiveRun, result: AgentExecutionResult): Promise<void> {
    if (run.disposed || run.state === "stopped") {
      if (!run.disposed) await this.finishTerminal(run);
      return;
    }
    try {
      if (!jsonValue(result.value)) throw new WorkflowError("INTERNAL_ERROR", "Subagent result is not a JSON value");
      const latest = [...result.attempts].reverse().find((attempt) => accountingValue(attempt.accounting));
      if (latest) this.recordAttemptAccounting(run, latest.accounting);
      const value = structuredClone(result.value);
      await enqueueWrite(run, () => atomicJson(resultPath(run.directory), value));
      if (this.terminalOrDisposed(run)) {
        await this.finishTerminal(run);
        return;
      }
      run.state = "completed";
      this.releaseConcurrency(run);
      run.finishedAt = Date.now();
      await this.finishTerminal(run);
    } catch (error) {
      await this.settleFailure(run, error);
    }
  }

  private async settleFailure(run: LiveRun, error: unknown): Promise<void> {
    if (run.disposed || run.state === "stopped") {
      if (!run.disposed) await this.finishTerminal(run);
      return;
    }
    const candidate = typeof error === "object" && error !== null ? (error as { attempts?: unknown }).attempts : undefined;
    if (Array.isArray(candidate)) {
      const attempts = candidate as unknown[];
      const latest = [...attempts].reverse().map((attempt) => {
        if (typeof attempt !== "object" || attempt === null) return undefined;
        const accounting = accountingValue((attempt as { accounting?: unknown }).accounting);
        return accounting === undefined ? undefined : { accounting };
      }).find((attempt) => attempt !== undefined);
      if (latest) this.recordAttemptAccounting(run, latest.accounting);
    }
    run.state = "failed";
    this.releaseConcurrency(run);
    run.error = failureFrom(error);
    run.finishedAt = Date.now();
    try {
      await enqueueWrite(run, () => atomicJson(failurePath(run.directory), run.error));
    } catch (persistenceError) {
      run.error = { code: "INTERNAL_ERROR", message: errorText(persistenceError) };
    }
    await this.finishTerminal(run);
  }

  private async finishTerminal(run: LiveRun): Promise<void> {
    if (run.disposed) return;
    run.finishedAt ??= Date.now();
    this.clearSteering(run);
    this.removeExternalAbort(run);
    if (!run.executorOwnsSession) await this.cleanupSession(run, true, false);
    try {
      await this.cleanupWorktree(run);
    } catch {
      // Keep the terminal result and recovery context when cleanup must be retried later.
    }
    try {
      await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
    } catch {
      // The terminal state remains available in memory when storage becomes unavailable.
    }
    this.removeLiveRun(run);
    if (run.state === "completed" || run.state === "failed") this.notify(run);
  }

  private notify(run: LiveRun): void {
    const notify = this.dependencies.notify;
    if (!notify || run.notificationSent || run.disposed) return;
    run.notificationSent = true;
    const notification: SubagentNotification = { id: run.id, state: run.state as "completed" | "failed", ...(run.error === undefined ? {} : { error: run.error }) };
    const pending = Promise.resolve().then(() => notify(notification));
    this.notificationPromises.add(pending);
    void pending.then(() => { this.notificationPromises.delete(pending); }, () => { this.notificationPromises.delete(pending); });
  }

  private removeLiveRun(run: LiveRun): void {
    if (this.activeRuns.get(run.id) !== run) return;
    this.activeRuns.delete(run.id);
    this.terminalSummaries.delete(run.id);
    this.terminalSummaries.set(run.id, terminalSummary(run));
    while (this.terminalSummaries.size > MAX_TERMINAL_SUMMARIES) {
      const oldest = this.terminalSummaries.keys().next().value;
      if (oldest === undefined) break;
      this.terminalSummaries.delete(oldest);
    }
  }
}

export function createUnavailableSubagentManager(): SubagentManager {
  return {
    run: async () => unavailable("run"),
    status: async () => unavailable("status"),
    result: async () => unavailable("result"),
    steer: async () => unavailable("steer"),
    stop: async () => unavailable("stop"),
    retry: async () => unavailable("retry"),
    list: async () => unavailable("list"),
  };
}
export function createSubagentManager(dependencies: SubagentManagerDependencies = {}): SubagentManager {
  const manager: SubagentManager = new PersistentSubagentManager(dependencies);
  return {
    run: (request, context) => manager.run(request, context),
    status: (request, context) => manager.status(request, context),
    result: (request, context) => manager.result(request, context),
    steer: (request, context) => manager.steer(request, context),
    stop: (request, context) => manager.stop(request, context),
    retry: (request, context) => manager.retry(request, context),
    list: (request, context) => manager.list(request, context),
    dispose: async () => { await manager.dispose?.(); },
  };
}
