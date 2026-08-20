import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolTimingExtension, TOOL_TIMING_ENTRY_TYPE, type ToolTimingEntry } from "../src/tool-timing.js";

type ToolEvent = { type: "tool_execution_start" | "tool_execution_end"; toolCallId: string; toolName: string; isError?: boolean };

void test("records completed tool timing independently by toolCallId", () => {
  let now = 1_000;
  const handlers = new Map<ToolEvent["type"], (event: ToolEvent) => void>();
  const entries: Array<{ type: string; data: ToolTimingEntry }> = [];
  const api = {
    on(name: "tool_execution_start" | "tool_execution_end", handler: (event: ToolEvent) => void) { handlers.set(name, handler); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data: data as ToolTimingEntry }); },
  } as unknown as ExtensionAPI;
  void createToolTimingExtension(() => now)(api);

  handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "first", toolName: "bash" });
  now = 1_100;
  handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "second", toolName: "read" });
  now = 1_250;
  handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "second", toolName: "read", isError: true });
  now = 1_400;
  handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "first", toolName: "bash", isError: false });
  handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "crashed", toolName: "grep" });

  assert.deepEqual(entries, [
    { type: TOOL_TIMING_ENTRY_TYPE, data: { toolCallId: "second", toolName: "read", startedAt: 1_100, completedAt: 1_250, durationMs: 150, isError: true } },
    { type: TOOL_TIMING_ENTRY_TYPE, data: { toolCallId: "first", toolName: "bash", startedAt: 1_000, completedAt: 1_400, durationMs: 400, isError: false } },
  ]);
});
