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

// NOTE: Keep this factory closure-free because Herdr serializes its source for the child Pi process.
// NOTE: The entry type literal must match TOOL_TIMING_ENTRY_TYPE; it is local for the same serialization boundary.
type ClockedToolTimingExtension = (pi: ExtensionAPI, clock?: () => number) => void;
// Bound unfinished executions so missing end events cannot grow session state indefinitely.
const MAX_ACTIVE_TOOL_TIMINGS = 400;
const toolTimingExtension: ClockedToolTimingExtension = (pi, clock = Date.now) => {
  const starts = new Map<string, { toolName: string; startedAt: number }>();
  pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
    if (!starts.has(event.toolCallId) && starts.size >= MAX_ACTIVE_TOOL_TIMINGS) return;
    starts.set(event.toolCallId, { toolName: event.toolName, startedAt: clock() });
  });
  pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
    const started = starts.get(event.toolCallId);
    if (started === undefined) return;
    starts.delete(event.toolCallId);
    const completedAt = clock();
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

export const TOOL_TIMING_EXTENSION: ExtensionFactory = toolTimingExtension;

export function createToolTimingExtension(clock: () => number = Date.now): ExtensionFactory {
  if (clock === Date.now) return TOOL_TIMING_EXTENSION;
  return (pi: ExtensionAPI) => { toolTimingExtension(pi, clock); };
}
