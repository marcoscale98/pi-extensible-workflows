import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { listRunIds, RunStore, type AwaitingCheckpoint, type EffectiveSystemPrompt, type PersistedRun } from "./persistence.js";
import type { LaunchSnapshot, WorkflowAgentSessionReference } from "./types.js";
import { errorText, isNodeError, object, positiveInteger, resourcePatternHasMagic, selectResourcesByLayers } from "./utils.js";

const DEFAULT_TRAJECTORY_PORT = 7432;
const TRAJECTORY_IDLE_EXIT_MS = 5 * 60 * 1000;
const TRAJECTORY_LOCK_NAME = "trajectory.lock";
const TRAJECTORY_MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const TRAJECTORY_MAX_NON_TIMING_ENTRIES = 400;

export type TrajectoryRun = {
  run: PersistedRun;
  snapshot: Readonly<LaunchSnapshot>;
  awaiting: readonly AwaitingCheckpoint[];
  createdAt?: string;
  transcripts: Readonly<Record<string, readonly unknown[]>>;
};

export type TrajectoryAction = "checkpoint-approve" | "checkpoint-reject" | "pause" | "resume" | "stop" | "retry";
export type TrajectoryActionRequest = { action: TrajectoryAction; runId: string; name?: string };
const TRAJECTORY_ACTIONS: readonly TrajectoryAction[] = ["checkpoint-approve", "checkpoint-reject", "pause", "resume", "stop", "retry"];
function isTrajectoryAction(value: unknown): value is TrajectoryAction { return typeof value === "string" && TRAJECTORY_ACTIONS.includes(value as TrajectoryAction); }
export type TrajectoryActionHandler = (request: Readonly<TrajectoryActionRequest>) => Promise<void>;
export type TrajectoryRunLoader = () => Promise<readonly TrajectoryRun[]>;

export type TrajectoryPublisherInput = {
  cwd: string;
  sessionId: string;
  port?: number;
  themes: boolean;
  loadRuns: TrajectoryRunLoader;
  handleAction: TrajectoryActionHandler;
};

type TrajectoryPublisherClient = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: unknown) => void): void;
};

type TrajectoryPublisherConstructor = new (url: string) => TrajectoryPublisherClient;

type TrajectoryLock = { pid: number; port: number };
export type TrajectoryController = {
  open(input: TrajectoryPublisherInput): Promise<{ port: number }>;
  close(): Promise<void>;
};
function trajectoryLockPath(agentDir: string): string { return join(agentDir, "pi-extensible-workflows", TRAJECTORY_LOCK_NAME); }
function trajectoryServerPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDirectory, "trajectory-server.js"), join(moduleDirectory, "trajectory-server.ts"), join(moduleDirectory, "../dist/src/trajectory-server.js")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Trajectory server implementation is unavailable");
  return path;
}
function publisherId(cwd: string, sessionId: string): string { return createHash("sha256").update(`${cwd}\n${sessionId}`).digest("hex").slice(0, 16); }
function trajectoryPort(value: unknown): number { return positiveInteger(value) && value <= 65535 ? value : DEFAULT_TRAJECTORY_PORT; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function serverHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) });
    return response.ok;
  } catch { return false; }
}

async function readLock(path: string): Promise<TrajectoryLock | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(parsed) || !positiveInteger(parsed.pid) || !positiveInteger(parsed.port) || parsed.port > 65535) return undefined;
    return { pid: parsed.pid, port: parsed.port };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return undefined;
  }
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await serverHealthy(port)) return;
    await delay(50);
  }
  throw new Error(`Trajectory server did not start on port ${String(port)}`);
}

async function ensureTrajectoryServer(agentDir: string, configuredPort: number): Promise<{ port: number }> {
  const lockPath = trajectoryLockPath(agentDir);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const existing = await readLock(lockPath);
  if (existing) {
    if (await serverHealthy(existing.port)) return existing;
    let alive = true;
    try { process.kill(existing.pid, 0); } catch (error) {
      if (!isNodeError(error, "ESRCH")) throw error;
      alive = false;
    }
    if (alive) {
      await waitForServer(existing.port);
      return existing;
    }
    await rm(lockPath, { force: true });
  }
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, port: configuredPort })}\n`, "utf8");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      const raced = await readLock(lockPath);
      if (raced && await serverHealthy(raced.port)) return raced;
      if (!raced) {
        await rm(lockPath, { force: true });
        lockHandle = await open(lockPath, "wx", 0o600);
        await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, port: configuredPort })}\n`, "utf8");
      } else {
        await waitForServer(raced.port);
        return raced;
      }
    } else {
      throw error;
    }
  } finally { await lockHandle?.close(); }
  try {
    const child = spawn(process.execPath, [trajectoryServerPath(), "--port", String(configuredPort), "--lock", lockPath], { detached: true, stdio: "ignore" });
    const startupError = new Promise<never>((_resolve, reject) => { child.once("error", reject); });
    child.unref();
    await Promise.race([waitForServer(configuredPort), startupError]);
    return { port: configuredPort };
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }
}

function trajectoryWebSocket(): TrajectoryPublisherConstructor | undefined {
  const candidate = (globalThis as unknown as { WebSocket?: TrajectoryPublisherConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : undefined;
}

function sessionFile(reference: WorkflowAgentSessionReference | undefined): string | undefined {
  const locator = reference?.locator;
  if (!object(locator) || typeof locator.sessionFile !== "string" || !locator.sessionFile) return undefined;
  return locator.sessionFile;
}
function transcriptToolCallId(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  if (typeof value.toolCallId === "string") return value.toolCallId;
  const message = object(value.message) ? value.message : undefined;
  if (message && typeof message.toolCallId === "string") return message.toolCallId;
  if (!message || !Array.isArray(message.content)) return undefined;
  for (const part of message.content) if (object(part) && typeof part.id === "string") return part.id;
  return undefined;
}
function isTimingTranscriptEntry(value: unknown): boolean { return object(value) && value.type === "custom" && value.customType === "pi-workflows:tool-timing"; }
function timingToolCallId(value: unknown): string | undefined {
  if (!object(value) || !isTimingTranscriptEntry(value) || !object(value.data)) return undefined;
  return typeof value.data.toolCallId === "string" ? value.data.toolCallId : undefined;
}
async function readTranscript(path: string): Promise<readonly unknown[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(path);
    if (!info.isFile()) return [];
    const startOffset = Math.max(0, info.size - TRAJECTORY_MAX_TRANSCRIPT_BYTES);
    const length = info.size - startOffset;
    handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, startOffset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (startOffset > 0) {
      const firstLine = content.indexOf("\n");
      content = firstLine < 0 ? "" : content.slice(firstLine + 1);
    }
    const entries: unknown[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (object(value)) entries.push(value);
      } catch { /* A partially written JSONL line is ignored until the next poll. */ }
    }
    const retainedEntries = entries.filter((entry) => !isTimingTranscriptEntry(entry)).slice(-TRAJECTORY_MAX_NON_TIMING_ENTRIES);
    const retainedIds = new Set(retainedEntries.map(transcriptToolCallId).filter((id): id is string => id !== undefined));
    const retainedTiming = entries.filter((entry) => { const id = timingToolCallId(entry); return id !== undefined && retainedIds.has(id); });
    const retained = new Set([...retainedEntries, ...retainedTiming]);
    return entries.filter((entry) => retained.has(entry));
  } catch { return []; }
  finally { await handle?.close(); }
}

function transcriptPaths(run: PersistedRun): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const agent of run.agents) {
    const path = sessionFile(agent.attemptDetails?.at(-1)?.session);
    if (path) paths.set(agent.id, path);
  }
  return paths;
}

async function runTranscripts(run: PersistedRun): Promise<Readonly<Record<string, readonly unknown[]>>> {
  const result: Record<string, readonly unknown[]> = {};
  for (const [agentId, path] of transcriptPaths(run)) result[agentId] = await readTranscript(path);
  return result;
}

export function applySystemPrompts(run: PersistedRun, prompts: readonly EffectiveSystemPrompt[]): PersistedRun {
  if (!prompts.length) return run;
  const bySession = new Map<string, string>();
  for (const entry of prompts) bySession.set(entry.sessionId, entry.prompt);
  const agents = run.agents.map((agent) => {
    if (agent.systemPrompt) return agent;
    const sessionId = agent.attemptDetails?.at(-1)?.session?.sessionId;
    const prompt = typeof sessionId === "string" ? bySession.get(sessionId) : undefined;
    if (prompt === undefined) return agent;
    return { ...agent, systemPrompt: prompt };
  });
  if (agents.every((agent, index) => agent === run.agents[index])) return run;
  return { ...run, agents };
}

export function applyToolDescriptions(run: PersistedRun, catalog: ReadonlyMap<string, string>): PersistedRun {
  const agents = run.agents.map((agent) => {
    if (agent.toolDefinitions?.length) return agent;
    const toolDefinitions = agent.tools.flatMap((name) => {
      const description = catalog.get(name);
      return description ? [{ name, description }] : [];
    });
    if (!toolDefinitions.length) return agent;
    return { ...agent, toolDefinitions };
  });
  if (agents.every((agent, index) => agent === run.agents[index])) return run;
  return { ...run, agents };
}

function piToolCatalog(): ReadonlyMap<string, string> {
  const cwd = process.cwd();
  return new Map([
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
  ].map((tool) => [tool.name, tool.description]));
}

export function withPiToolDescriptions(run: PersistedRun): PersistedRun {
  return applyToolDescriptions(run, piToolCatalog());
}

function canonicalSourcePath(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function canonicalExtensionSelector(selector: string, base: string): string {
  const negated = selector.startsWith("!");
  const body = negated ? selector.slice(1) : selector;
  if (body === "*" || body === "**" || body.startsWith("**/")) return selector;
  const resolved = resolve(base, body);
  if (resourcePatternHasMagic(body)) return `${negated ? "!" : ""}${resolved}`;
  return `${negated ? "!" : ""}${canonicalSourcePath(resolved)}`;
}
function skillNameFromPath(path: string): string {
  const file = basename(path);
  return file.toLowerCase() === "skill.md" ? basename(dirname(path)) : file;
}

let discoveredResourcesPromise: Promise<{ skills: readonly string[]; extensions: readonly string[] }> | undefined;
async function discoveredResources(cwd: string): Promise<{ skills: readonly string[]; extensions: readonly string[] }> {
  discoveredResourcesPromise ??= (async () => {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    return {
      extensions: [...new Set(resolved.extensions.filter((entry) => entry.enabled).map((entry) => canonicalSourcePath(entry.path)))],
      skills: [...new Set(resolved.skills.filter((entry) => entry.enabled).map((entry) => skillNameFromPath(entry.path)))],
    };
  })();
  return discoveredResourcesPromise;
}

export async function withResolvedResources(run: PersistedRun, cwd: string): Promise<PersistedRun> {
  const needed = run.agents.some((agent) => {
    const inspection = agent.attemptDetails?.at(-1)?.setup.resourceSelectors;
    return Boolean(inspection && (!inspection.skills.length || !inspection.extensions.length));
  });
  if (!needed) return run;
  let discovered: { skills: readonly string[]; extensions: readonly string[] };
  try { discovered = await discoveredResources(cwd); } catch { return run; }
  const agents = run.agents.map((agent) => {
    const details = agent.attemptDetails;
    const last = details?.at(-1);
    const inspection = last?.setup.resourceSelectors;
    if (!details || !last || !inspection) return agent;
    const sources = inspection.selectorSources ?? { global: inspection.selectors, project: {} };
    const skills = inspection.skills.length ? inspection.skills : selectResourcesByLayers([sources.global.skills, sources.project.skills, sources.role?.skills, sources.call?.skills], discovered.skills);
    const extensions = inspection.extensions.length ? inspection.extensions : selectResourcesByLayers([sources.global.extensions, sources.project.extensions, sources.role?.extensions, sources.call?.extensions].map((layer) => layer?.map((selector) => canonicalExtensionSelector(selector, last.setup.cwd || cwd))), discovered.extensions);
    if (skills === inspection.skills && extensions === inspection.extensions) return agent;
    return { ...agent, attemptDetails: [...details.slice(0, -1), { ...last, setup: { ...last.setup, resourceSelectors: { ...inspection, skills, extensions } } }] };
  });
  if (agents.every((agent, index) => agent === run.agents[index])) return run;
  return { ...run, agents };
}

async function loadTrajectoryRun(store: RunStore): Promise<TrajectoryRun> {
  const value = await store.load();
  const summary = await store.loadSummary().catch(() => undefined);
  const prompts = await store.systemPrompts().catch(() => []);
  const run = await withResolvedResources(withPiToolDescriptions(applySystemPrompts(value.run, prompts)), store.cwd);
  return { run, snapshot: value.snapshot, awaiting: await store.awaitingCheckpoints(), ...(summary?.createdAt === undefined ? {} : { createdAt: summary.createdAt }), transcripts: await runTranscripts(run) };
}

export async function loadTrajectoryRuns(cwd: string, sessionId: string, home = homedir(), overlay?: (run: PersistedRun) => PersistedRun): Promise<readonly TrajectoryRun[]> {
  const loaded: TrajectoryRun[] = [];
  for (const runId of await listRunIds(cwd, sessionId, home, false)) {
    try {
      const value = await loadTrajectoryRun(new RunStore(cwd, sessionId, runId, home));
      loaded.push(overlay ? { ...value, run: overlay(value.run) } : value);
    } catch { /* Ignore corrupt or concurrently removed runs. */ }
  }
  return loaded;
}

type CachedTrajectoryRun = { value: TrajectoryRun; stateMtimeMs: number; journalMtimeMs: number; transcriptMtimes: ReadonlyMap<string, number | undefined> };
async function fileMtime(path: string): Promise<number | undefined> { return stat(path).then((value) => value.mtimeMs).catch(() => undefined); }
async function cacheEntryChanged(store: RunStore, entry: CachedTrajectoryRun): Promise<boolean> {
  const stateMtimeMs = await fileMtime(join(store.directory, "state.json"));
  const journalMtimeMs = await fileMtime(join(store.directory, "journal.json"));
  if (stateMtimeMs !== entry.stateMtimeMs || journalMtimeMs !== entry.journalMtimeMs) return true;
  for (const [agentId, path] of transcriptPaths(entry.value.run)) if (await fileMtime(path) !== entry.transcriptMtimes.get(agentId)) return true;
  return false;
}

export function createTrajectoryRunLoader(cwd: string, sessionId: string, home = homedir(), overlay?: (run: PersistedRun) => PersistedRun): TrajectoryRunLoader {
  const cache = new Map<string, CachedTrajectoryRun>();
  return async () => {
    const ids = await listRunIds(cwd, sessionId, home, false);
    const current = new Set(ids);
    for (const runId of cache.keys()) if (!current.has(runId)) cache.delete(runId);
    const loaded: TrajectoryRun[] = [];
    for (const runId of ids) {
      const store = new RunStore(cwd, sessionId, runId, home);
      try {
        let entry = cache.get(runId);
        if (!entry || await cacheEntryChanged(store, entry)) {
          const value = await loadTrajectoryRun(store);
          const transcriptMtimes = new Map<string, number | undefined>();
          for (const [agentId, path] of transcriptPaths(value.run)) transcriptMtimes.set(agentId, await fileMtime(path));
          entry = { value, stateMtimeMs: (await fileMtime(join(store.directory, "state.json"))) ?? 0, journalMtimeMs: (await fileMtime(join(store.directory, "journal.json"))) ?? 0, transcriptMtimes };
          cache.set(runId, entry);
        }
        loaded.push(overlay ? { ...entry.value, run: overlay(entry.value.run) } : entry.value);
      } catch { cache.delete(runId); /* Ignore corrupt or concurrently removed runs. */ }
    }
    return loaded;
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => undefined);
    child.unref();
  } catch { /* Browser launch is best effort; the URL remains in the notification. */ }
}

export function trajectoryUrl(port: number): string { return `http://127.0.0.1:${String(port)}/`; }
export function openTrajectoryUrl(url: string): void { openBrowser(url); }

export function createTrajectoryController(agentDir: string): TrajectoryController {
  let socket: TrajectoryPublisherClient | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let currentInput: TrajectoryPublisherInput | undefined;
  let closing = false;
  const stopPolling = () => { if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; } };
  let stateLoad: Promise<void> | undefined;
  let lastState: string | undefined;
  const sendState = async (): Promise<void> => {
    if (stateLoad) return stateLoad;
    const task = (async () => {
      const activeSocket = socket;
      const input = currentInput;
      if (!activeSocket || !input || activeSocket.readyState !== 1) return;
      const runs = await input.loadRuns();
      if (closing || socket !== activeSocket) return;
      const state = { type: "publisher:state", publisher: { id: publisherId(input.cwd, input.sessionId), title: `session ${input.sessionId.slice(0, 8)}`, cwd: basename(input.cwd), sessionId: input.sessionId, themes: input.themes }, runs };
      const serialized = JSON.stringify(state);
      if (serialized === lastState) return;
      lastState = serialized;
      activeSocket.send(serialized);
    })();
    stateLoad = task;
    try { await task; }
    finally { if (stateLoad === task) stateLoad = undefined; }
  };
  const connect = async (port: number, input: TrajectoryPublisherInput): Promise<void> => {
    const Constructor = trajectoryWebSocket();
    if (!Constructor) throw new Error("Trajectory requires a WebSocket-capable Node runtime");
    const next = new Constructor(`ws://127.0.0.1:${String(port)}/ws`);
    socket = next;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve();
      };
      next.addEventListener("open", () => { finish(); });
      next.addEventListener("error", () => { finish(new Error("Could not connect to Trajectory server")); });
    });
    next.addEventListener("close", () => { if (socket === next) { socket = undefined; lastState = undefined; stopPolling(); } });
    next.addEventListener("message", (event) => {
      try {
        const message: unknown = JSON.parse(typeof event === "object" && event !== null && "data" in event ? String(event.data) : "");
        if (!object(message) || message.type !== "publisher:action" || typeof message.requestId !== "string") return;
        if (!isTrajectoryAction(message.action)) { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: "Unsupported Trajectory action" })); return; }
        void input.handleAction({ action: message.action, runId: typeof message.runId === "string" ? message.runId : "", ...(typeof message.name === "string" ? { name: message.name } : {}) }).then(() => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: true })); }, (error: unknown) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: errorText(error) })); }).catch(() => undefined);
      } catch { /* Ignore malformed local browser messages. */ }
    });
    next.send(JSON.stringify({ type: "publisher:attach", publisherId: publisherId(input.cwd, input.sessionId) }));
  };
  return {
    async open(input) {
      closing = false;
      currentInput = input;
      const envPort = process.env.PI_WORKFLOW_TRAJECTORY_PORT;
      const configured = envPort !== undefined && /^\d+$/.test(envPort) ? trajectoryPort(Number(envPort)) : trajectoryPort(input.port);
      const server = await ensureTrajectoryServer(agentDir, configured);
      if (!socket || socket.readyState !== 1) await connect(server.port, input);
      stopPolling();
      await sendState();
      pollTimer = setInterval(() => { void sendState().catch(() => undefined); }, 1000);
      pollTimer.unref();
      return server;
    },
    async close() {
      closing = true;
      currentInput = undefined;
      stopPolling();
      const activeSocket = socket;
      socket = undefined;
      activeSocket?.close();
    },
  };
}


export { DEFAULT_TRAJECTORY_PORT, TRAJECTORY_IDLE_EXIT_MS, TRAJECTORY_LOCK_NAME };
