import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { loadingRegistry, registerWorkflowExtension, WorkflowError, type AgentOptions, type JsonSchema, type WorkflowExtension } from "pi-extensible-workflows";
import type { SubagentIdRequest, SubagentInspectRequest, SubagentManager, SubagentManagerContext, SubagentNotification, SubagentsExtension, SubagentsExtensionOptions, SubagentRunRequest, SubagentSteerRequest } from "./contracts.js";
import { createSubagentManager } from "./manager.js";
import {
  normalizeSingleAgentRequest,
  normalizeSubagentRunRequest,
  SUBAGENTS_ID_PARAMETERS,
  SUBAGENTS_INSPECT_PARAMETERS,
  SUBAGENTS_RETRY_PARAMETERS,
  SUBAGENTS_RUN_PARAMETERS,
  SUBAGENTS_SINGLE_AGENT_PARAMETERS,
  SUBAGENTS_STEER_PARAMETERS,
  SUBAGENTS_STOP_PARAMETERS,
} from "./contracts.js";

export * from "./contracts.js";
export { createSubagentManager, createUnavailableSubagentManager } from "./manager.js";
export { createRunStoreWorktreeAdapter, defaultWorktreeHome } from "./worktree.js";
export type { SubagentWorktreeAdapter, SubagentWorktreeContext, SubagentWorktreeHandle, SubagentWorktreeRunStore } from "./worktree.js";

type SubagentsExtensionAPI = Pick<ExtensionAPI, "registerTool"> & Partial<Pick<ExtensionAPI, "getActiveTools" | "on" | "sendMessage">>;

function validateSubagentRunRequest(value: unknown): SubagentRunRequest {
  return normalizeSubagentRunRequest(value);
}

function validateSubagentIdRequest(value: unknown, operation: string): SubagentIdRequest {
  if (!Value.Check(SUBAGENTS_ID_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", `Invalid ${operation} parameters`);
  return value;
}

function validateSubagentInspectRequest(value: unknown): SubagentInspectRequest {
  if (!Value.Check(SUBAGENTS_INSPECT_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", "Invalid subagents_inspect parameters");
  return value;
}

function validateSubagentSteerRequest(value: unknown): SubagentSteerRequest {
  if (!Value.Check(SUBAGENTS_STEER_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", "Invalid subagents_steer parameters");
  return value;
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: serialize(value) }], details: value };
}

function managerContext(toolCallId: string, signal: AbortSignal | undefined, onUpdate: ((value: AgentToolResult<unknown>) => void) | undefined, context: ExtensionContext): SubagentManagerContext {
  return {
    toolCallId,
    signal,
    onUpdate: onUpdate === undefined ? undefined : (value) => { onUpdate(toolResult(value)); },
    extensionContext: context,
  };
}
function singleAgentOptions(request: Readonly<SubagentRunRequest>): AgentOptions {
  const role = request.role;
  return {
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking as NonNullable<AgentOptions["thinking"]> }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(role === undefined ? {} : { role: role as NonNullable<AgentOptions["role"]> }),
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema as JsonSchema }),
    ...(request.retries === undefined ? {} : { retries: request.retries }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
}

const SUBAGENTS_AGENT_OUTPUT_SCHEMA = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.Unknown()), Type.Record(Type.String(), Type.Unknown())]);
const SUBAGENTS_WORKFLOW_EXTENSION = {
  version: "1.0.0",
  headline: "Subagents workflow integration",
  functions: {
    singleAgent: {
      description: "Run one agent inline with the subagents request options.",
      input: structuredClone(SUBAGENTS_SINGLE_AGENT_PARAMETERS),
      output: SUBAGENTS_AGENT_OUTPUT_SCHEMA,
      async run(input, context) {
        const request = normalizeSingleAgentRequest(input);
        const options = singleAgentOptions(request);
        if (request.worktree === undefined) return context.agent(request.prompt, options);
        return context.withWorktree(request.worktree, async (reference) => {
          void reference;
          return context.agent(request.prompt, options);
        });
      },
    },
  },
} satisfies WorkflowExtension;

function registerSubagentsWorkflowExtension(): void {
  const functionDefinition = SUBAGENTS_WORKFLOW_EXTENSION.functions.singleAgent;
  const existing = loadingRegistry().functions().singleAgent;
  if (existing === functionDefinition || existing !== undefined && existing.description === functionDefinition.description && JSON.stringify(existing.input) === JSON.stringify(functionDefinition.input) && JSON.stringify(existing.output) === JSON.stringify(functionDefinition.output)) return;
  registerWorkflowExtension(SUBAGENTS_WORKFLOW_EXTENSION);
}

export function createSubagentTools(manager: SubagentManager): readonly ToolDefinition[] {
  return [
    defineTool({
      name: "subagents_run",
      label: "Subagents Run",
      description: "Start a durable subagent run. Background mode returns its ID immediately; foreground mode waits and returns the terminal value or error in this tool call. Use the ID with subagents_inspect, subagents_steer, subagents_stop, or subagents_retry.",
      promptSnippet: "Run durable subagents in background by default; inspect, steer, stop, or retry them with the other subagents tools.",
      promptGuidelines: [
        "Runs are background by default; choose mode: \"foreground\" only when the terminal envelope is needed in this turn.",
        "Do not poll a running ID; use subagents_inspect({ id }) when you need its current status or terminal result.",
      ],
      parameters: SUBAGENTS_RUN_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.run(validateSubagentRunRequest(params), managerContext(toolCallId, signal, onUpdate, context)));
      },
    }),
    defineTool({
      name: "subagents_inspect",
      label: "Subagents Inspect",
      description: "Inspect durable subagent runs. Omit id for ordered run summaries, or provide id for detailed status, progress, activity, accounting, tool calls, timestamps, worktree metadata, and a terminal value or error when available.",
      parameters: SUBAGENTS_INSPECT_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.inspect(validateSubagentInspectRequest(params), managerContext(toolCallId, signal, onUpdate, context)));
      },
    }),
    defineTool({
      name: "subagents_steer",
      label: "Subagents Steer",
      description: "Send a message to a running subagent. The message is queued safely if its steering handler is not ready; settled runs cannot be steered.",
      parameters: SUBAGENTS_STEER_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.steer(validateSubagentSteerRequest(params), managerContext(toolCallId, signal, onUpdate, context)));
      },
    }),
    defineTool({
      name: "subagents_stop",
      label: "Subagents Stop",
      description: "Stop one running subagent, abort its active session, persist state \"stopped\", and clean its worktree without affecting sibling runs.",
      parameters: SUBAGENTS_STOP_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.stop(validateSubagentIdRequest(params, "subagents_stop"), managerContext(toolCallId, signal, onUpdate, context)));
      },
    }),
    defineTool({
      name: "subagents_retry",
      label: "Subagents Retry",
      description: "Start a fresh run from a failed or stopped subagent's persisted request. The new run gets a new ID and preserves its original background or foreground mode.",
      parameters: SUBAGENTS_RETRY_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.retry(validateSubagentIdRequest(params, "subagents_retry"), managerContext(toolCallId, signal, onUpdate, context)));
      },
    }),
  ];
}

function notificationContent(notification: { id: string; state: "completed" | "failed"; error?: { code: string; message: string } }): string {
  if (notification.state === "completed") return `Subagent ${notification.id} completed. Inspect it with subagents_inspect({ id: "${notification.id}" }).`;
  return `Subagent ${notification.id} failed: ${notification.error?.message ?? "unknown error"}. Inspect it with subagents_inspect({ id: "${notification.id}" }).`;
}
function managerDependencies(options: SubagentsExtensionOptions, activeTools: (() => readonly string[]) | undefined, notify: ((notification: SubagentNotification) => void | Promise<void>) | undefined): SubagentsExtensionOptions["managerDependencies"] {
  const dependencies = options.managerDependencies;
  const next = {
    ...(dependencies ?? {}),
    ...(activeTools !== undefined && dependencies?.getActiveTools === undefined ? { getActiveTools: activeTools } : {}),
    ...(notify !== undefined && dependencies?.notify === undefined ? { notify } : {}),
  };
  return Object.keys(next).length === 0 ? dependencies : next;
}

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}, activeTools?: () => readonly string[], notify?: (notification: SubagentNotification) => void | Promise<void>): SubagentsExtension {
  const manager = options.manager ?? createSubagentManager(managerDependencies(options, activeTools, notify));
  return { manager, tools: createSubagentTools(manager) };
}

export function registerSubagentsExtension(pi: SubagentsExtensionAPI, options: SubagentsExtensionOptions = {}): SubagentsExtension {
  try {
    registerSubagentsWorkflowExtension();
  } catch (error) {
    if (!(error instanceof WorkflowError) || error.code !== "GLOBAL_COLLISION" && error.code !== "REGISTRY_FROZEN") throw error;
  }
  const getActiveTools = pi.getActiveTools;
  const activeTools = getActiveTools === undefined ? undefined : () => getActiveTools.call(pi);
  const sendMessage = pi.sendMessage;
  const notify = sendMessage === undefined ? undefined : (notification: SubagentNotification): void => {
    sendMessage.call(pi, { customType: "subagents", content: notificationContent(notification), display: true, details: notification }, { deliverAs: "followUp", triggerTurn: true });
  };
  const extension = createSubagentsExtension(options, activeTools, notify);
  for (const tool of extension.tools) pi.registerTool(tool);
  if (pi.on !== undefined) pi.on("session_shutdown", async () => { await extension.manager.dispose?.(); });
  return extension;
}

export default function extension(pi: ExtensionAPI, options: SubagentsExtensionOptions = {}): void {
  registerSubagentsExtension(pi, options);
}
