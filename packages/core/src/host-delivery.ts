import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { structuralPath as operationPath, type PersistedRun, type RunStore } from "./persistence.js";
import { ERROR_CODES, WorkflowError, type JsonValue, type WorkflowErrorCode, type WorkflowFailureAgent, type WorkflowFailureDiagnostics, type WorkflowMetadata, type WorkflowSiblingAgent } from "./types.js";
import { errorCode, errorText, isWorkflowAuthored, object } from "./utils.js";
const workflowFailureDiagnostics = new WeakMap<WorkflowError, WorkflowFailureDiagnostics>();
export function markWorkflowFailureDiagnostics(error: WorkflowError, diagnostic: WorkflowFailureDiagnostics): void { workflowFailureDiagnostics.set(error, diagnostic); }

function workflowDetail(message: string): string {
  const detail = message.trim().replace(new RegExp(`\\b(?:${ERROR_CODES.join("|")})\\b:?\\s*`, "g"), "").replace(/^\s*[A-Z][A-Z0-9_]+:\s*/, "").split("\n").filter((line) => !/^\s*at\s/.test(line)).join("\n").replace(/^Run \S+(?=\s(?:exceeded|is))/i, "Run").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the workflow").replace(/^(?:Pi )session \S+(?=\s(?:is|has))/i, "session").replace(/^(Unknown scheduler run|Missing production ownership record|Persisted agent belongs to another run):\s*\S+/i, "$1").replace(/\b(?:runId|sessionId|callSite|occurrence|failedAt|id)[:=]\s*\S+/gi, "").replace(/\s{2,}/g, " ").trim();
  return detail || "No further details were provided";
}

const WORKFLOW_ERROR_PROSE: Record<WorkflowErrorCode, (detail: string) => string> = {
  CONFIG_ERROR: (detail) => `The workflow configuration is invalid: ${detail}.`,
  INVALID_SETTINGS: (detail) => `The workflow settings are invalid: ${detail}.`,
  INVALID_SYNTAX: (detail) => `The workflow source is invalid: ${detail}.`,
  INVALID_METADATA: (detail) => `The workflow metadata is invalid: ${detail}.`,
  DUPLICATE_NAME: (detail) => `The workflow contains a duplicate name: ${detail}.`,
  INVALID_SCHEMA: (detail) => `The workflow schema is invalid: ${detail}.`,
  REGISTRY_FROZEN: (detail) => `Workflow extension registration is closed: ${detail}.`,
  GLOBAL_COLLISION: (detail) => `The workflow global name is already in use: ${detail}.`,
  MISSING_WORKFLOW: (detail) => `The registered workflow function is unavailable: ${detail}.`,
  UNKNOWN_MODEL: (detail) => `The workflow requested the unavailable model ${detail.replace(/^(?:Unknown model(?: for role [^:]+)?|Invalid model spec):\s*/, "")}.`,
  UNKNOWN_TOOL: (detail) => `The workflow requested the unavailable tool ${detail.replace(/^Unknown tool:\s*/, "")}.`,
  UNKNOWN_AGENT_TYPE: (detail) => `The workflow requested the unavailable agent role ${detail.replace(/^Unknown agent role:\s*/, "")}.`,
  RUN_OWNED: (detail) => /already owned|active ownership/.test(detail) ? "The workflow session is already in use." : `The workflow session is already in use: ${detail}.`,
  RUN_NOT_FOUND: (detail) => /^Unknown workflow run\b/.test(detail) ? "The workflow run was not found." : `The workflow run was not found: ${detail}.`,
  RPC_LIMIT_EXCEEDED: (detail) => `The workflow communication data exceeded its size limit: ${detail}.`,
  SHELL_FAILED: (detail) => `The workflow shell command failed: ${detail}.`,
  AGENT_TIMEOUT: (detail) => `The workflow agent timed out: ${detail}.`,
  AGENT_FAILED: (detail) => `The workflow agent failed: ${detail}.`,
  AGENT_RESULT_COLLECTED: (detail) => `The nested agent result was already collected: ${detail}.`,
  RESULT_INVALID: (detail) => `The workflow produced an invalid result: ${detail}.`,
  CANCELLED: (detail) => `The workflow was cancelled: ${detail}.`,
  WORKER_UNRESPONSIVE: (detail) => `The workflow worker stopped responding: ${detail}.`,
  WORKTREE_FAILED: (detail) => `The workflow worktree operation failed: ${detail}.`,
  RESUME_INCOMPATIBLE: (detail) => `The workflow cannot resume this run: ${detail}.`,
  BUDGET_EXHAUSTED: (detail) => `The workflow budget was exhausted: ${detail}.`,
  INTERNAL_ERROR: (detail) => `The workflow encountered an internal error: ${detail}.`,
};
export function formatWorkflowFailure(error: unknown): string {
  if (isWorkflowAuthored(error)) return errorText(error);
  const code = errorCode(error);
  if (code) return WORKFLOW_ERROR_PROSE[code](workflowDetail(errorText(error)));
  if (error instanceof Error) return error.message || "The workflow failed without an error message.";
  return `The workflow failed with value ${String(error)}.`;
}
export function workflowFailedAt(error: unknown): string | undefined { return object(error) && typeof error.failedAt === "string" && error.failedAt ? error.failedAt : undefined; }
export const DELIVERY_LIMIT_BYTES = 4 * 1024;
export const WORKFLOW_LOG_ENTRY = "workflow-log";
export interface WorkflowLogEntry { workflowName: string; message: string }

export interface CompletionContextUsage { tokens: number | null; contextWindow: number }
export interface CompletionDeliveryModel { contextWindow?: number; maxTokens?: number }
export interface CompletionDeliveryContext {
  getContextUsage?: () => CompletionContextUsage | undefined;
  getModel?: () => CompletionDeliveryModel | undefined;
  model?: CompletionDeliveryModel;
}
export interface CompletionDeliveryOptions {
  mode: "foreground" | "background";
  name: string;
  runId: string;
  value: JsonValue;
  resultPath: string;
  resultBytes: number;
  worktrees: readonly { branch: string; path: string }[];
  context?: CompletionDeliveryContext;
}
export interface CompletionDeliveryResult { content: string; inlined: boolean }

function positiveFinite(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) && value > 0; }
function deliveryEnvelope(mode: CompletionDeliveryOptions["mode"], content: string, runId: string): string {
  const timestamp = Date.now();
  if (mode === "foreground") return JSON.stringify({ role: "toolResult", toolCallId: runId, toolName: "workflow", content: [{ type: "text", text: content }, { type: "text", text: `Workflow run ID: ${runId}` }], isError: false, timestamp });
  return JSON.stringify({ role: "custom", customType: "workflow", content, display: true, timestamp });
}
function fitsMainContext(options: CompletionDeliveryOptions, content: string): boolean {
  let usage: CompletionContextUsage | undefined;
  let model: CompletionDeliveryModel | undefined;
  try {
    usage = options.context?.getContextUsage?.();
    model = options.context?.getModel?.() ?? options.context?.model;
  } catch { return false; }
  if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens) || usage.tokens < 0 || !positiveFinite(model?.maxTokens)) return false;
  const contextWindow = positiveFinite(model.contextWindow) ? Math.min(model.contextWindow, usage.contextWindow) : usage.contextWindow;
  if (!positiveFinite(contextWindow)) return false;
  const deliveryTokens = Math.ceil(Buffer.byteLength(deliveryEnvelope(options.mode, content, options.runId), "utf8") / 4);
  return usage.tokens + deliveryTokens + model.maxTokens <= contextWindow;
}

export function completionDelivery(options: CompletionDeliveryOptions): CompletionDeliveryResult {
  const descriptor = JSON.stringify({ state: "completed", runId: options.runId, resultPath: options.resultPath, resultBytes: options.resultBytes, inlined: false });
  if (!Number.isSafeInteger(options.resultBytes) || options.resultBytes < 0 || options.resultBytes > DEFAULT_MAX_BYTES) return { content: descriptor, inlined: false };
  const serialized = JSON.stringify(options.value);
  const locations = options.worktrees.length ? ` Changes: ${options.worktrees.map(({ branch, path }) => `${branch} (${path})`).join(", ")}.` : "";
  const inlineContent = options.mode === "foreground" ? serialized : `Workflow ${options.name} completed: ${serialized}${locations}`;
  return fitsMainContext(options, inlineContent) ? { content: inlineContent, inlined: true } : { content: descriptor, inlined: false };
}

export function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
const DIAGNOSTIC_LIMIT_BYTES = DELIVERY_LIMIT_BYTES - 512;
export function failureDiagnosticsFrom(error: unknown): WorkflowFailureDiagnostics | undefined {
  return error instanceof WorkflowError ? workflowFailureDiagnostics.get(error) : undefined;
}

function boundedWorkflowFailureDiagnostics(value: WorkflowFailureDiagnostics): WorkflowFailureDiagnostics {
  let bounded: WorkflowFailureDiagnostics = {
    runId: utf8Prefix(value.runId, 128),
    workflowName: utf8Prefix(value.workflowName, 256),
    state: value.state,
    failedAt: value.failedAt === null ? null : utf8Prefix(value.failedAt, 1024),
    error: { code: value.error.code, message: utf8Prefix(value.error.message, 1024) },
    ...(value.failedAgent ? { failedAgent: {
      id: utf8Prefix(value.failedAgent.id, 128),
      ...(value.failedAgent.label ? { label: utf8Prefix(value.failedAgent.label, 128) } : {}),
      ...(value.failedAgent.role ? { role: utf8Prefix(value.failedAgent.role, 128) } : {}),
      structuralPath: value.failedAgent.structuralPath.slice(0, 8).map((part) => utf8Prefix(part, 128)),
      attempt: value.failedAgent.attempt,
      ...(value.failedAgent.transport ? { transport: utf8Prefix(value.failedAgent.transport, 128) } : {}),
      ...(value.failedAgent.session ? { session: structuredClone(value.failedAgent.session) } : {}),
    } } : {}),
    completedSiblingAgents: (value.completedSiblingAgents ?? []).slice(0, 16).map((agent) => ({
      id: utf8Prefix(agent.id, 128),
      ...(agent.label ? { label: utf8Prefix(agent.label, 128) } : {}),
      ...(agent.role ? { role: utf8Prefix(agent.role, 128) } : {}),
      structuralPath: agent.structuralPath.slice(0, 8).map((part) => utf8Prefix(part, 128)),
    })),
    completedSiblingPaths: value.completedSiblingPaths.slice(0, 16).map((path) => path.slice(0, 8).map((part) => utf8Prefix(part, 128))),
    ...(value.retry ? { retry: { sourceRunId: utf8Prefix(value.retry.sourceRunId, 128), action: utf8Prefix(value.retry.action, 256), completedPaths: value.retry.completedPaths.slice(0, 16).map((path) => utf8Prefix(path, 256)), incompletePaths: value.retry.incompletePaths.slice(0, 16).map((path) => utf8Prefix(path, 256)), namedWorktrees: value.retry.namedWorktrees.slice(0, 16).map((name) => utf8Prefix(name, 128)), warning: utf8Prefix(value.retry.warning, 512) } } : {}),
    artifacts: { runDirectory: utf8Prefix(value.artifacts.runDirectory, 1024), statePath: utf8Prefix(value.artifacts.statePath, 1024), journalPath: utf8Prefix(value.artifacts.journalPath, 1024) },
  };
  const size = () => Buffer.byteLength(JSON.stringify(bounded));
  while (size() > DIAGNOSTIC_LIMIT_BYTES) {
    if (bounded.completedSiblingAgents?.length || bounded.completedSiblingPaths.length) {
      bounded = { ...bounded, completedSiblingAgents: bounded.completedSiblingAgents?.slice(0, -1) ?? [], completedSiblingPaths: bounded.completedSiblingPaths.slice(0, -1) };
      continue;
    }
    if (bounded.retry && (bounded.retry.completedPaths.length || bounded.retry.incompletePaths.length || bounded.retry.namedWorktrees.length)) {
      const retry = { ...bounded.retry };
      if (retry.completedPaths.length) retry.completedPaths = retry.completedPaths.slice(0, -1);
      else if (retry.incompletePaths.length) retry.incompletePaths = retry.incompletePaths.slice(0, -1);
      else retry.namedWorktrees = retry.namedWorktrees.slice(0, -1);
      bounded = { ...bounded, retry };
      continue;
    }
    if (Buffer.byteLength(bounded.artifacts.runDirectory) > 256) { bounded = { ...bounded, artifacts: { ...bounded.artifacts, runDirectory: utf8Prefix(bounded.artifacts.runDirectory, 256) } }; continue; }
    if (Buffer.byteLength(bounded.error.message) > 256) { bounded = { ...bounded, error: { ...bounded.error, message: utf8Prefix(bounded.error.message, 256) } }; continue; }
    if (bounded.failedAt !== null && Buffer.byteLength(bounded.failedAt) > 256) { bounded = { ...bounded, failedAt: utf8Prefix(bounded.failedAt, 256) }; continue; }
    if (bounded.failedAgent && bounded.failedAgent.structuralPath.length > 4) { bounded = { ...bounded, failedAgent: { ...bounded.failedAgent, structuralPath: bounded.failedAgent.structuralPath.slice(0, 4) } }; continue; }
    if (bounded.failedAgent?.structuralPath.some((part) => Buffer.byteLength(part) > 64)) { bounded = { ...bounded, failedAgent: { ...bounded.failedAgent, structuralPath: bounded.failedAgent.structuralPath.map((part) => utf8Prefix(part, 64)) } }; continue; }
    if (Buffer.byteLength(bounded.artifacts.statePath) > 512 || Buffer.byteLength(bounded.artifacts.journalPath) > 512) { bounded = { ...bounded, artifacts: { ...bounded.artifacts, statePath: utf8Prefix(bounded.artifacts.statePath, 512), journalPath: utf8Prefix(bounded.artifacts.journalPath, 512) } }; continue; }
    if (Buffer.byteLength(bounded.workflowName) > 128) { bounded = { ...bounded, workflowName: utf8Prefix(bounded.workflowName, 128) }; continue; }
    break;
  }
  return bounded;
}
async function diagnosticNamedWorktrees(store: RunStore, run: PersistedRun): Promise<readonly string[]> {
  const names = new Set<string>();
  try {
    for (const name of await store.validNamedWorktrees()) names.add(name);
  } catch { /* Do not block failure delivery on an invalid worktree record. */ }
  for (const name of run.retry?.namedWorktrees ?? []) {
    try { await store.resolveNamedWorktree(name); names.add(name); } catch { /* Do not advertise stale inherited worktrees. */ }
  }
  return [...names];
}
export function incompleteRetryPaths(paths: readonly string[], completedPaths: readonly string[]): string[] {
  return [...new Set(paths)].filter((path) => !completedPaths.some((completedPath) => completedPath === path || completedPath.startsWith(`${path}/`)));
}
export async function createWorkflowFailureDiagnostics(store: RunStore, metadata: WorkflowMetadata, error: unknown, run: PersistedRun): Promise<WorkflowFailureDiagnostics> {
  const failedAt = workflowFailedAt(error) ?? null;
  const failedAgents = run.agents.filter((agent) => agent.state === "failed");
  const failedAgentRecord = failedAgents.find((agent) => {
    if (failedAt === null) return false;
    try { return failedAt.includes(`${operationPath("agent", ...(agent.structuralPath ?? []))}/`); } catch { return false; }
  }) ?? failedAgents.at(-1);
  const failedAttempt = failedAgentRecord ? [...(failedAgentRecord.attemptDetails ?? [])].reverse().find((attempt) => attempt.error) ?? failedAgentRecord.attemptDetails?.at(-1) : undefined;
  const failedAgent = failedAgentRecord ? {
    id: failedAgentRecord.id,
    ...(failedAgentRecord.label ?? failedAgentRecord.name ? { label: failedAgentRecord.label ?? failedAgentRecord.name } : {}),
    ...(failedAgentRecord.role ? { role: failedAgentRecord.role } : {}),
    structuralPath: [...(failedAgentRecord.structuralPath ?? [])],
    attempt: Math.max(1, failedAttempt?.attempt ?? failedAgentRecord.attempts),
    ...(failedAttempt?.transport ? { transport: failedAttempt.transport } : {}),
    ...(failedAttempt?.session ? { session: failedAttempt.session } : {}),
  } satisfies WorkflowFailureAgent : undefined;
  const completedSiblingAgents = run.agents.filter((agent) => {
    if (agent.state !== "completed" || agent.id === failedAgentRecord?.id) return false;
    return failedAgentRecord?.parentId === undefined ? agent.parentId === undefined : agent.parentId === failedAgentRecord.parentId;
  }).map((agent) => ({
    id: agent.id,
    ...(agent.label ?? agent.name ? { label: agent.label ?? agent.name } : {}),
    ...(agent.role ? { role: agent.role } : {}),
    structuralPath: [...(agent.structuralPath ?? [])],
  } satisfies WorkflowSiblingAgent));
  const completedSiblingPaths = completedSiblingAgents.map((agent) => [...agent.structuralPath]);
  let journalCompletedPaths: readonly string[] = [];
  try { journalCompletedPaths = (await store.replayableOperations()).map(({ path }) => path); } catch { /* Preserve failure diagnostics when retry history is unavailable. */ }
  const completedPaths = run.retry ? [...new Set([...run.retry.completedPaths, ...journalCompletedPaths])] : journalCompletedPaths.length ? journalCompletedPaths : run.agents.filter((agent) => agent.state === "completed").map((agent) => operationPath("agent", ...(agent.structuralPath ?? [])));
  const namedWorktrees = await diagnosticNamedWorktrees(store, run);
  const retry = run.state === "failed" ? {
    sourceRunId: run.id,
    action: `workflow_retry({ runId: ${JSON.stringify(run.id)} })`,
    completedPaths,
    incompletePaths: incompleteRetryPaths([...(run.retry?.incompletePaths ?? []), ...(failedAt ? [failedAt] : [])], completedPaths),
    namedWorktrees,
    warning: "Retry re-executes incomplete operations; external side effects before failure are not guaranteed exactly once.",
  } : undefined;
  return boundedWorkflowFailureDiagnostics({
    runId: run.id, workflowName: metadata.name, state: run.state, failedAt,
    error: { code: errorCode(error) ?? "INTERNAL_ERROR", message: errorText(error) || "The workflow failed without an error message." },
    ...(failedAgent ? { failedAgent } : {}), completedSiblingAgents, completedSiblingPaths,
    ...(retry ? { retry } : {}),
    artifacts: { runDirectory: store.directory, statePath: join(store.directory, "state.json"), journalPath: join(store.directory, "journal.json") },
  });
}

export function formatWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string {
  const failedAgent = diagnostic.failedAgent ? `${diagnostic.failedAgent.label ?? diagnostic.failedAgent.id}${diagnostic.failedAgent.role ? ` role=${diagnostic.failedAgent.role}` : ""} attempt=${String(diagnostic.failedAgent.attempt)} path=${diagnostic.failedAgent.structuralPath.join(" > ") || "(root)"}${diagnostic.failedAgent.session ? ` session=${diagnostic.failedAgent.session.transport}/${diagnostic.failedAgent.session.sessionId}` : ""}` : "(not persisted)";
  const siblingAgents = diagnostic.completedSiblingAgents;
  const siblings = siblingAgents ? siblingAgents.map((agent) => `${agent.label ?? agent.id}${agent.role ? ` role=${agent.role}` : ""} path=${agent.structuralPath.join(" > ") || "(root)"}`).join(", ") || "(none)" : diagnostic.completedSiblingPaths.map((path) => path.join(" > ") || "(root)").join(", ") || "(none)";
  const retry = diagnostic.retry ? [`  Retry: ${diagnostic.retry.action}`, `  Replayable completed paths: ${diagnostic.retry.completedPaths.join(", ") || "(none)"}`, `  Incomplete paths: ${diagnostic.retry.incompletePaths.join(", ") || "(unknown)"}`, `  Named worktrees: ${diagnostic.retry.namedWorktrees.join(", ") || "(none)"}`, `  Warning: ${diagnostic.retry.warning}`] : [];
  return [`✗ Workflow: ${diagnostic.workflowName}`, `  Run: ${diagnostic.runId}`, `  State: ${diagnostic.state}`, `  Error: ${diagnostic.error.code}: ${diagnostic.error.message}`, `  Failed at: ${diagnostic.failedAt ?? "(unknown)"}`, `  Failed agent: ${failedAgent}`, `  Completed sibling ${siblingAgents ? "agents" : "paths"}: ${siblings}`, ...retry, `  Artifacts: state=${diagnostic.artifacts.statePath} journal=${diagnostic.artifacts.journalPath}`].join("\n");
}
function deliveryPart(value: string, maxBytes: number): string { return utf8Prefix(value.replace(/\s+/g, " ").trim(), maxBytes) || "(unknown)"; }
export function formatWorkflowFailureDelivery(diagnostic: WorkflowFailureDiagnostics): string {
  const name = deliveryPart(diagnostic.workflowName, 128);
  const runId = deliveryPart(diagnostic.runId, 128);
  const error = `${diagnostic.error.code}: ${deliveryPart(diagnostic.error.message, 768)}`;
  const failedPath = diagnostic.failedAt ? `; failed path=${deliveryPart(diagnostic.failedAt, 512)}` : "";
  const nextAction = diagnostic.retry ? `; next action: ${deliveryPart(diagnostic.retry.action, 256)}` : "";
  const artifacts = `; artifacts: runDirectory=${deliveryPart(diagnostic.artifacts.runDirectory, 512)} statePath=${deliveryPart(diagnostic.artifacts.statePath, 512)} journalPath=${deliveryPart(diagnostic.artifacts.journalPath, 512)}`;
  const line = `Workflow ${name} failed (runId=${runId}): error=${error}${failedPath}${nextAction}${artifacts}`;
  return Buffer.byteLength(line) <= DELIVERY_LIMIT_BYTES ? line : utf8Prefix(line, DELIVERY_LIMIT_BYTES);
}
export function formatWorkflowFailureDeliveryFallback(workflowName: string, runId: string, runDirectory: string, error: unknown): string {
  const code = errorCode(error) ?? "INTERNAL_ERROR";
  const failedPath = workflowFailedAt(error);
  const nextAction = code === "BUDGET_EXHAUSTED" || code === "CANCELLED" ? "" : `; next action: workflow_retry({ runId: ${JSON.stringify(runId)} })`;
  const line = `Workflow ${deliveryPart(workflowName, 128)} failed (runId=${deliveryPart(runId, 128)}): error=${code}: ${deliveryPart(formatWorkflowFailure(error), 768)}${failedPath ? `; failed path=${deliveryPart(failedPath, 512)}` : ""}${nextAction}; artifacts: runDirectory=${deliveryPart(runDirectory, 512)} statePath=${deliveryPart(join(runDirectory, "state.json"), 512)} journalPath=${deliveryPart(join(runDirectory, "journal.json"), 512)}`;
  return Buffer.byteLength(line) <= DELIVERY_LIMIT_BYTES ? line : utf8Prefix(line, DELIVERY_LIMIT_BYTES);
}

export function serializeWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string { return JSON.stringify(diagnostic); }
export function isWorkflowFailureDiagnostics(value: unknown): value is WorkflowFailureDiagnostics {
  return object(value) && typeof value.runId === "string" && typeof value.workflowName === "string" && typeof value.state === "string" && "failedAt" in value && object(value.error) && object(value.artifacts);
}
