import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentActivity, AgentAccounting, AgentAttemptSummary, AgentExecutionOptions, AgentExecutionResult, AgentExecutionRoot, AgentProgress, AgentToolCallProgress, AgentTransport, LiveSessionHandoff, PreparedAgentSession, WorkflowAgentSession, WorkflowAgentSessionReference } from "pi-extensible-workflows";
import { validateAgentOptions, WorkflowError } from "pi-extensible-workflows";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { SubagentWorktreeAdapter } from "./worktree.js";

export const SUBAGENTS_TOOL_NAMES = [
  "subagents_run",
  "subagents_inspect",
  "subagents_steer",
  "subagents_stop",
  "subagents_retry",
] as const;
export const SUBAGENT_ATTEMPT_DETAILS_LIMIT = 1;
export const SUBAGENT_MAX_RETRIES = 255;
export const SUBAGENT_SYSTEM_PROMPT_LIMIT = 64 * 1024;

const SUBAGENTS_ROLE_OVERRIDE = Type.Object({
  name: Type.String({ description: "Workflow role name" }),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  thinking: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  tools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  skills: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  extensions: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  overrideSystemPrompt: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  contextFiles: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
}, { additionalProperties: false });
const SUBAGENTS_MODE = Type.Union([
  Type.Literal("background"),
  Type.Literal("foreground"),
], { description: "Launch mode; background is the default and foreground waits for the terminal envelope" });

export const SUBAGENTS_RUN_PARAMETERS = Type.Object({
  prompt: Type.String({ description: "Task for the subagent" }),
  mode: Type.Optional(SUBAGENTS_MODE),
  label: Type.Optional(Type.String({ description: "Optional display label for the subagent" })),
  model: Type.Optional(Type.String({ description: "Optional model selection" })),
  thinking: Type.Optional(Type.String({ description: "Optional thinking level" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional ordered tool selectors; candidates start enabled and !* restricts the set" })),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Optional ordered skill selectors; candidates start enabled and !* restricts the set" })),
  extensions: Type.Optional(Type.Array(Type.String(), { description: "Optional ordered extension selectors; candidates start enabled and !* restricts the set" })),
  role: Type.Optional(Type.Union([Type.String({ description: "Workflow role name" }), SUBAGENTS_ROLE_OVERRIDE])),
  worktree: Type.Optional(Type.String({ description: "Optional named worktree" })),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional JSON schema for the result" })),
  retries: Type.Optional(Type.Integer({ minimum: 0, maximum: SUBAGENT_MAX_RETRIES, description: "Optional retry count; at most 255 retries" })),
  timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1, description: "Optional execution timeout in milliseconds" }), Type.Null()])),
}, { additionalProperties: false });

export const SUBAGENTS_INSPECT_PARAMETERS = Type.Object({
  id: Type.Optional(Type.String({ description: "Subagent ID; omit to list ordered run summaries" })),
}, { additionalProperties: false });

export const SUBAGENTS_ID_PARAMETERS = Type.Object({
  id: Type.String({ description: "Subagent ID" }),
}, { additionalProperties: false });

export const SUBAGENTS_STEER_PARAMETERS = Type.Object({
  id: Type.String({ description: "Subagent ID" }),
  message: Type.String({ description: "Message to send to the running subagent" }),
}, { additionalProperties: false });

export const SUBAGENTS_STOP_PARAMETERS = Type.Object({
  id: Type.String({ description: "Subagent ID" }),
}, { additionalProperties: false });

export const SUBAGENTS_RETRY_PARAMETERS = Type.Object({
  id: Type.String({ description: "Failed or stopped subagent ID to retry" }),
}, { additionalProperties: false });

export const SUBAGENTS_TOOL_SCHEMAS = {
  subagents_run: SUBAGENTS_RUN_PARAMETERS,
  subagents_inspect: SUBAGENTS_INSPECT_PARAMETERS,
  subagents_steer: SUBAGENTS_STEER_PARAMETERS,
  subagents_stop: SUBAGENTS_STOP_PARAMETERS,
  subagents_retry: SUBAGENTS_RETRY_PARAMETERS,
} as const;

export type SubagentRunRequest = Static<typeof SUBAGENTS_RUN_PARAMETERS>;
export function normalizeSubagentRunRequest(value: unknown): SubagentRunRequest {
  if (!Value.Check(SUBAGENTS_RUN_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", "Invalid subagents_run parameters");
  validateAgentOptions(value);
  if (typeof value.worktree === "string" && !value.worktree.trim()) throw new WorkflowError("INVALID_METADATA", "worktree name must be a non-empty string");
  const snapshot = structuredClone(value);
  snapshot.mode ??= "background";
  if (snapshot.worktree !== undefined) snapshot.worktree = snapshot.worktree.trim();
  return snapshot;
}
export type SubagentInspectRequest = Static<typeof SUBAGENTS_INSPECT_PARAMETERS>;
export type SubagentIdRequest = Static<typeof SUBAGENTS_ID_PARAMETERS>;
export type SubagentSteerRequest = Static<typeof SUBAGENTS_STEER_PARAMETERS>;
export type SubagentProgress = {
  readonly accounting: AgentAccounting;
  readonly toolCalls: readonly AgentToolCallProgress[];
  readonly state?: Omit<NonNullable<AgentProgress["state"]>, "systemPrompt">;
  readonly activity?: AgentActivity;
  readonly lastEventAt?: number;
};
export interface SubagentStatus {
  readonly id: string;
  readonly sessionId?: string;
  readonly state: "running" | "completed" | "failed" | "stopped";
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly worktree?: { readonly path: string; readonly branch: string };
  readonly error?: { readonly code: string; readonly message: string };
  readonly progress?: SubagentProgress;
  readonly attempts?: number;
  readonly attemptDetails?: readonly AgentAttemptSummary[];
}
export interface SubagentNotification {
  readonly id: string;
  readonly label?: string;
  readonly role?: string;
  readonly state: "completed" | "failed";
  readonly error?: { readonly code: string; readonly message: string };
}
export interface SubagentManagerContext {
  readonly toolCallId: string;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((value: unknown) => void) | undefined;
  readonly extensionContext: ExtensionContext;
  readonly waitForForeground?: boolean;
  readonly includeAttemptMetadata?: boolean;
}
export interface SubagentAttemptActionData {
  readonly attempt: AgentAttemptSummary;
  readonly session?: WorkflowAgentSessionReference;
  readonly liveSession?: WorkflowAgentSession;
  readonly prepared?: Readonly<PreparedAgentSession>;
  readonly handoff?: LiveSessionHandoff;
  readonly signal: AbortSignal;
}

export interface SubagentOwnerMarker {
  readonly pid: number;
  readonly processStart: number;
  readonly sessionId: string;
  readonly token: string;
  readonly acquiredAt: number;
}

export interface SubagentLiveness {
  readonly pid?: number;
  readonly processStart?: number;
  readonly sessionId?: string;
  readonly token?: string;
  readonly isLive?: (owner: Readonly<SubagentOwnerMarker>) => boolean | Promise<boolean>;
}
export interface SubagentExecutor {
  execute(task: string, options: AgentExecutionOptions, signal?: AbortSignal, setSteer?: (handler: (message: string) => void | Promise<void>) => void): Promise<AgentExecutionResult>;
}
export interface SubagentManagerDependencies {
  readonly getActiveTools?: () => readonly string[];
  readonly agentDir?: string;
  readonly storageDir?: string;
  readonly transport?: AgentTransport;
  readonly createExecutor?: (root: AgentExecutionRoot, transport: AgentTransport) => SubagentExecutor;
  readonly worktreeAdapter?: SubagentWorktreeAdapter;
  readonly liveness?: SubagentLiveness;
  readonly notify?: (notification: Readonly<SubagentNotification>) => void | Promise<void>;
  readonly onStatus?: (status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>) => void;
}
export interface SubagentManager {
  run(request: Readonly<SubagentRunRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  inspect(request: Readonly<SubagentInspectRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  steer(request: Readonly<SubagentSteerRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  stop(request: Readonly<SubagentIdRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  retry(request: Readonly<SubagentIdRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  getAttemptActionData?(id: string): Readonly<SubagentAttemptActionData> | undefined;
  dispose?(): Promise<void>;
}

export interface SubagentsExtensionOptions {
  readonly manager?: SubagentManager;
  readonly clipboard?: (value: string) => Promise<void>;
  readonly managerDependencies?: SubagentManagerDependencies;
}

export interface SubagentsExtension {
  readonly manager: SubagentManager;
  readonly tools: readonly ToolDefinition[];
}
