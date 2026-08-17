import assert from "node:assert/strict";
import test from "node:test";
import { addAccounting, sumAccounting, zeroAccounting, type AgentAccounting } from "../src/index.js";

void test("accounting helpers create and combine agent usage totals", () => {
  const first: AgentAccounting = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 };
  const second: AgentAccounting = { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: 0.75 };
  const expected: AgentAccounting = { input: 9, output: 11, cacheRead: 13, cacheWrite: 15, cost: 1 };

  assert.deepEqual(zeroAccounting(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.deepEqual(addAccounting(first, second), expected);
  assert.deepEqual(sumAccounting([first, second]), expected);
  assert.deepEqual(sumAccounting([]), zeroAccounting());
  assert.deepEqual(first, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 });
  assert.deepEqual(second, { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: 0.75 });
});
