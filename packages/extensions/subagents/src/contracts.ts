import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentActivity, AgentAccounting, AgentExecutionOptions, AgentExecutionResult, AgentExecutionRoot, AgentProgress, AgentToolCallProgress, AgentTransport } from "pi-extensible-workflows";
import { validateAgentOptions, WorkflowError } from "pi-extensible-workflows";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { SubagentWorktreeAdapter } from "./worktree.js";

export const SUBAGENTS_TOOL_NAMES = [
  "subagents_run",
  "subagents_status",
  "subagents_result",
  "subagents_steer",
  "subagents_stop",
  "subagents_retry",
  "subagents_list",
] as const;

const SUBAGENTS_ROLE_OVERRIDE = Type.Object({
  name: Type.String({ description: "Workflow role name" }),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  thinking: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  tools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  overrideSystemPrompt: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  contextFiles: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  disabledAgentResources: Type.Optional(Type.Union([Type.Object({
    skills: Type.Optional(Type.Array(Type.String())),
    extensions: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false }), Type.Null()])),
}, { additionalProperties: false });

export const SUBAGENTS_RUN_PARAMETERS = Type.Object({
  prompt: Type.String({ description: "Task for the subagent" }),
  label: Type.Optional(Type.String({ description: "Optional display label for the subagent" })),
  model: Type.Optional(Type.String({ description: "Optional model selection" })),
  thinking: Type.Optional(Type.String({ description: "Optional thinking level" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tools available to the subagent" })),
  role: Type.Optional(Type.Union([Type.String({ description: "Workflow role name" }), SUBAGENTS_ROLE_OVERRIDE])),
  worktree: Type.Optional(Type.String({ description: "Optional named worktree" })),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional JSON schema for the result" })),
  retries: Type.Optional(Type.Integer({ minimum: 0, description: "Optional retry count" })),
  timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1, description: "Optional execution timeout in milliseconds" }), Type.Null()])),
}, { additionalProperties: false });

export const SUBAGENTS_STATUS_PARAMETERS = Type.Object({
  id: Type.String({ description: "Subagent ID" }),
}, { additionalProperties: false });

export const SUBAGENTS_RESULT_PARAMETERS = Type.Object({
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
  id: Type.String({ description: "Subagent ID" }),
}, { additionalProperties: false });

export const SUBAGENTS_LIST_PARAMETERS = Type.Object({}, { additionalProperties: false });

export const SUBAGENTS_TOOL_SCHEMAS = {
  subagents_run: SUBAGENTS_RUN_PARAMETERS,
  subagents_status: SUBAGENTS_STATUS_PARAMETERS,
  subagents_result: SUBAGENTS_RESULT_PARAMETERS,
  subagents_steer: SUBAGENTS_STEER_PARAMETERS,
  subagents_stop: SUBAGENTS_STOP_PARAMETERS,
  subagents_retry: SUBAGENTS_RETRY_PARAMETERS,
  subagents_list: SUBAGENTS_LIST_PARAMETERS,
} as const;

export type SubagentRunRequest = Static<typeof SUBAGENTS_RUN_PARAMETERS>;
export function normalizeSubagentRunRequest(value: unknown): SubagentRunRequest {
  if (!Value.Check(SUBAGENTS_RUN_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", "Invalid subagents_run parameters");
  validateAgentOptions(value);
  if (typeof value.worktree === "string" && !value.worktree.trim()) throw new WorkflowError("INVALID_METADATA", "worktree name must be a non-empty string");
  const snapshot = structuredClone(value);
  if (snapshot.worktree !== undefined) snapshot.worktree = snapshot.worktree.trim();
  return snapshot;
}
export type SubagentIdRequest = Static<typeof SUBAGENTS_STATUS_PARAMETERS>;
export type SubagentSteerRequest = Static<typeof SUBAGENTS_STEER_PARAMETERS>;
export type SubagentListRequest = Static<typeof SUBAGENTS_LIST_PARAMETERS>;
export type SubagentUsage = {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
};
export type SubagentProgress = Pick<AgentProgress, "accounting" | "toolCalls" | "state" | "activity" | "lastEventAt">;
export interface SubagentStatus {
  readonly id: string;
  readonly state: "running" | "completed" | "failed" | "stopped";
  readonly worktree?: { readonly path: string; readonly branch: string };
  readonly error?: { readonly code: string; readonly message: string };
  readonly progress?: SubagentProgress;
  readonly activity?: AgentActivity;
  readonly usage?: SubagentUsage;
  readonly toolCalls?: readonly AgentToolCallProgress[];
  readonly accounting?: AgentAccounting;
  readonly lastEventAt?: number;
}
export interface SubagentNotification {
  readonly id: string;
  readonly state: "completed" | "failed";
  readonly error?: { readonly code: string; readonly message: string };
}
export interface SubagentManagerContext {
  readonly toolCallId: string;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((value: unknown) => void) | undefined;
  readonly extensionContext: ExtensionContext;
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
}
export interface SubagentManager {
  run(request: Readonly<SubagentRunRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  status(request: Readonly<SubagentIdRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  result(request: Readonly<SubagentIdRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  steer(request: Readonly<SubagentSteerRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  stop(request: Readonly<SubagentIdRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  retry(request: Readonly<SubagentIdRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  list(request: Readonly<SubagentListRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown>;
  dispose?(): Promise<void>;
}

export interface SubagentsExtensionOptions {
  readonly manager?: SubagentManager;
  readonly managerDependencies?: SubagentManagerDependencies;
}

export interface SubagentsExtension {
  readonly manager: SubagentManager;
  readonly tools: readonly ToolDefinition[];
}
