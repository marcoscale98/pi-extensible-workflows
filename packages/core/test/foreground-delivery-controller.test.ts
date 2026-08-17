import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedRun, RunStore } from "../src/persistence.js";
import { ForegroundDeliveryController } from "../src/host-delivery.js";

type FakeRun = {
  id: string;
  state: "running" | "completed" | "failed";
  delivery?: { mode: "foreground" | "background"; state: "attached" | "pending" | "delivered"; toolCallId?: string };
};

type FakeStore = {
  runId: string;
  updateState(update: (run: FakeRun) => FakeRun | Promise<FakeRun>): Promise<FakeRun>;
  load(): Promise<{ run: FakeRun }>;
};

type Delivery = {
  store: RunStore;
  inline: boolean;
  detached: boolean;
  detach: () => Promise<{ runId: string; state: "running"; detached: true; run: PersistedRun }>;
};

const waitForTurn = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

function storeFor(runId: string, state: FakeRun["state"] = "running", delivery: FakeRun["delivery"] = { mode: "foreground", state: "attached", toolCallId: runId }): { store: RunStore; run: FakeRun } {
  let run: FakeRun = { id: runId, state, delivery };
  const fake: FakeStore = {
    runId,
    async updateState(update) { run = await update(run); return run; },
    async load() { return { run }; },
  };
  return { store: fake as unknown as RunStore, run };
}

function controllerFor(store: RunStore, delivered: string[]): ForegroundDeliveryController {
  const runs = new Map<string, { store: RunStore }>([[store.runId, { store }]]);
  return new ForegroundDeliveryController({ runs, deliver: (content: string) => { delivered.push(content); } });
}

function attach(controller: ForegroundDeliveryController, toolCallId: string, store: RunStore, overrides: Partial<Omit<Delivery, "store">> = {}): Delivery {
  const delivery: Delivery = {
    store,
    inline: false,
    detached: false,
    detach: async () => ({ runId: store.runId, state: "running", detached: true, run: (await store.load()).run }),
    ...overrides,
  };
  controller.foregroundDeliveries.set(toolCallId, delivery);
  return delivery;
}

void test("inline foreground results are not promoted to follow-up delivery", async () => {
  const { store } = storeFor("inline");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "inline", store, { inline: true });

  controller.scheduleForegroundDelivery("inline", async () => { delivered.push("promoted"); });
  await waitForTurn();

  assert.deepEqual(delivered, []);
});

void test("non-inline foreground delivery promotes only after an event-loop turn", async () => {
  const { store } = storeFor("scheduled");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "scheduled", store);

  controller.scheduleForegroundDelivery("scheduled", async () => { delivered.push("promoted"); });
  assert.deepEqual(delivered, []);
  await waitForTurn();
  assert.deepEqual(delivered, ["promoted"]);
});

void test("detached foreground delivery uses background delivery and cleans its entry", async () => {
  const { store } = storeFor("detached", "running", { mode: "background", state: "pending", toolCallId: "detached" });
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  const delivery = attach(controller, "detached", store, { detached: true });
  delivery.detach = async () => {
    const current = (await store.load()).run;
    return { runId: current.id, state: "running", detached: true, run: current };
  };

  await controller.queueForegroundDelivery("detached", "background result", Promise.resolve());

  assert.deepEqual(delivered, ["background result"]);
  assert.equal(controller.foregroundDeliveries.has("detached"), false);
  assert.deepEqual((await store.load()).run.delivery, { mode: "background", state: "delivered", toolCallId: "detached" });
});

void test("attached completion waits for its result turn before background promotion", async () => {
  const { store } = storeFor("delayed");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "delayed", store);
  let releaseResult!: () => void;
  const resultReady = new Promise<void>((resolve) => { releaseResult = resolve; });

  const queued = controller.queueForegroundDelivery("delayed", "delayed result", resultReady);
  await waitForTurn();
  assert.deepEqual(delivered, []);

  releaseResult();
  await queued;
  assert.deepEqual(delivered, []);
  await waitForTurn();
  assert.deepEqual(delivered, ["delayed result"]);
  assert.equal(controller.foregroundDeliveries.has("delayed"), false);
});

void test("failure delivery clears pending diagnostics and preserves failure content", async () => {
  const { store } = storeFor("failure", "failed", { mode: "background", state: "pending", toolCallId: "failure" });
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "failure", store, { detached: true });
  (controller.pendingFailureDiagnostics as unknown as Map<string, unknown>).set("failure", { store, diagnostic: { runId: "failure" } });

  await controller.queueForegroundDelivery("failure", "failure diagnostics", Promise.resolve(), true);

  assert.deepEqual(delivered, ["failure diagnostics"]);
  assert.equal((controller.pendingFailureDiagnostics as unknown as Map<string, unknown>).has("failure"), false);
});

void test("a foreground resume claim suppresses the stale terminal delivery once", async () => {
  const { store } = storeFor("resume");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "resume", store);
  controller.foregroundResumeClaims.add(store);

  await controller.deliverTerminal(store, "stale completion");
  assert.deepEqual(delivered, []);
  assert.equal(controller.foregroundResumeClaims.has(store), false);
  assert.deepEqual((await store.load()).run.delivery, { mode: "foreground", state: "attached", toolCallId: "resume" });

  await controller.deliverTerminal(store, "resumed completion");
  assert.deepEqual(delivered, ["resumed completion"]);
});

void test("foreground candidates and detach state track only attached runs", async () => {
  const { store: attachedStore } = storeFor("attached");
  const { store: inlineStore } = storeFor("inline-candidate");
  const delivered: string[] = [];
  const runs = new Map<string, { store: RunStore }>([[attachedStore.runId, { store: attachedStore }], [inlineStore.runId, { store: inlineStore }]]);
  const controller = new ForegroundDeliveryController({ runs, deliver: (content: string) => { delivered.push(content); } });
  const attached = attach(controller, "attached", attachedStore);
  attach(controller, "inline-candidate", inlineStore, { inline: true });

  assert.equal(controller.isForegroundAttached("attached"), true);
  assert.equal(controller.isForegroundAttached("inline-candidate"), false);
  assert.equal(controller.foregroundDeliveryCandidates("attached").length, 1);

  attached.detach = async () => {
    await attachedStore.updateState((current) => ({ ...current, delivery: { mode: "background", state: "pending" } }));
    attached.detached = true;
    return { runId: "attached", state: "running", detached: true, run: (await attachedStore.load()).run };
  };
  const result = await controller.moveForegroundToBackground("attached");

  assert.deepEqual(result, { runId: "attached", state: "running", detached: true, run: (await attachedStore.load()).run });
  assert.equal(controller.isForegroundAttached("attached"), false);
});

void test("terminal deliveries for one store are serialized and only the first claim sends", async () => {
  const { store } = storeFor("lane");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const first = controller.deliverTerminal(store, async () => { await hold; return "first"; });
  const second = controller.deliverTerminal(store, "second");

  await waitForTurn();
  assert.deepEqual(delivered, []);
  release();
  await Promise.all([first, second]);

  assert.deepEqual(delivered, ["first"]);
});
