import type { ExtensionAPI, ExtensionFactory, ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";

export const TOOL_TIMING_ENTRY_TYPE = "pi-workflows:tool-timing";

export interface ToolTimingEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly isError: boolean;
}

export const TOOL_TIMING_EXTENSION: ExtensionFactory = (pi: ExtensionAPI) => {
  const starts = new Map<string, { toolName: string; startedAt: number }>();
  pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
    starts.set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });
  });
  pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
    const started = starts.get(event.toolCallId);
    if (started === undefined) return;
    starts.delete(event.toolCallId);
    const completedAt = Date.now();
    pi.appendEntry<ToolTimingEntry>("pi-workflows:tool-timing", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      startedAt: started.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - started.startedAt),
      isError: event.isError,
    });
  });
  pi.on("session_shutdown", () => { starts.clear(); });
};

export function createToolTimingExtension(clock: () => number = Date.now): ExtensionFactory {
  if (clock === Date.now) return TOOL_TIMING_EXTENSION;
  return (pi: ExtensionAPI) => {
    const starts = new Map<string, { toolName: string; startedAt: number }>();
    pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
      starts.set(event.toolCallId, { toolName: event.toolName, startedAt: clock() });
    });
    pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
      const started = starts.get(event.toolCallId);
      if (started === undefined) return;
      starts.delete(event.toolCallId);
      const completedAt = clock();
      pi.appendEntry<ToolTimingEntry>(TOOL_TIMING_ENTRY_TYPE, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        startedAt: started.startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - started.startedAt),
        isError: event.isError,
      });
    });
    pi.on("session_shutdown", () => { starts.clear(); });
  };
}
