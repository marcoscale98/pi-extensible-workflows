import assert from "node:assert/strict";
import test from "node:test";
import { coerceWorkflowError, SerialLane } from "../src/utils.js";
import { WorkflowError } from "../src/types.js";

void test("SerialLane runs queued tasks one at a time in submission order", async () => {
  const lane = new SerialLane();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = lane.run(async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return "first";
  });
  const second = lane.run(async () => {
    order.push("second");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

void test("coerceWorkflowError reuses a WorkflowError with the requested code", () => {
  const original = new WorkflowError("WORKTREE_FAILED", "worktree detail");

  assert.strictEqual(coerceWorkflowError("WORKTREE_FAILED", original), original);
  assert.equal(original.code, "WORKTREE_FAILED");
  assert.equal(original.message, "worktree detail");
});

void test("coerceWorkflowError wraps different-code and non-WorkflowError failures", () => {
  const differentCode = new WorkflowError("RESUME_INCOMPATIBLE", "resume detail");
  const wrappedDifferentCode = coerceWorkflowError("WORKTREE_FAILED", differentCode);
  assert.notStrictEqual(wrappedDifferentCode, differentCode);
  assert.ok(wrappedDifferentCode instanceof WorkflowError);
  assert.equal(wrappedDifferentCode.code, "WORKTREE_FAILED");
  assert.equal(wrappedDifferentCode.message, "resume detail");

  const original = new Error("filesystem detail");
  const wrappedError = coerceWorkflowError("RESUME_INCOMPATIBLE", original);
  assert.notStrictEqual(wrappedError, original);
  assert.ok(wrappedError instanceof WorkflowError);
  assert.equal(wrappedError.code, "RESUME_INCOMPATIBLE");
  assert.equal(wrappedError.message, "filesystem detail");
});

void test("SerialLane absorbs a failed task for subsequent tasks without hiding its error", async () => {
  const lane = new SerialLane();
  const failure = new Error("lane task failed");
  const failed = lane.run(async () => { throw failure; });
  const succeeding = lane.run(async () => "recovered");

  await assert.rejects(failed, failure);
  assert.equal(await succeeding, "recovered");
});
