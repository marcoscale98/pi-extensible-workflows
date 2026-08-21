import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, DefaultPackageManager, getAgentDir, SettingsManager, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { listRunIds, RunStore, type AwaitingCheckpoint, type EffectiveSystemPrompt, type PersistedRun } from "./persistence.js";
import { navigatorAttentionSortByState } from "./host-view.js";
import type { AgentAttemptSummary, JsonValue, LaunchSnapshot, WorkflowAgentSessionReference } from "./types.js";
import { normalizeSubagentRunRequest, type SubagentProgress, type SubagentRunRequest, type SubagentStatus } from "../subagents/src/contracts.js";
import { statusValue, subagentErrorValue } from "../subagents/src/decode.js";
import { errorText, isNodeError, jsonValue, object, positiveInteger, resourcePatternHasMagic, selectResourcesByLayers } from "./utils.js";

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
export type TrajectorySubagentArtifact = { readonly truncated: true; readonly path: string; readonly bytes: number };
export type TrajectorySubagent = {
  id: string;
  sessionId: string;
  cwd: string;
  label?: string;
  role?: string;
  mode: "background" | "foreground";
  state: SubagentStatus["state"];
  startedAt?: number;
  finishedAt?: number;
  attempts?: number;
  error?: { readonly code: string; readonly message: string };
  worktree?: { readonly path: string; readonly branch: string };
  request: Readonly<SubagentRunRequest>;
  tools: readonly string[];
  toolDefinitions?: readonly { readonly name: string; readonly description: string }[];
  model?: AgentAttemptSummary["setup"]["model"];
  progress?: SubagentProgress;
  attempt?: AgentAttemptSummary;
  result?: JsonValue | TrajectorySubagentArtifact;
  failure?: { readonly code: string; readonly message: string } | TrajectorySubagentArtifact;
  transcript: readonly unknown[];
};
export type TrajectorySubagentLoader = () => Promise<readonly TrajectorySubagent[]>;

export type TrajectoryTarget = { kind: "run" | "subagent"; id: string };
export type TrajectoryAction = "checkpoint-approve" | "checkpoint-reject" | "pause" | "resume" | "steer" | "stop" | "retry";
export type TrajectoryActionRequest = { action: TrajectoryAction; target: TrajectoryTarget; name?: string; payload?: unknown };
const TRAJECTORY_ACTIONS: readonly TrajectoryAction[] = ["checkpoint-approve", "checkpoint-reject", "pause", "resume", "steer", "stop", "retry"];
export function isTrajectoryAction(value: unknown): value is TrajectoryAction { return typeof value === "string" && TRAJECTORY_ACTIONS.includes(value as TrajectoryAction); }
export function isTrajectoryTarget(value: unknown): value is TrajectoryTarget { return object(value) && (value.kind === "run" || value.kind === "subagent") && typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 200; }
export function trajectoryActionError(action: TrajectoryAction, target: TrajectoryTarget): string | undefined { return target.kind === "subagent" && (action === "checkpoint-approve" || action === "checkpoint-reject" || action === "pause" || action === "resume") ? `Trajectory action ${action} is not supported for subagent targets` : target.kind === "run" && action === "steer" ? "Trajectory action steer is not supported for run targets" : undefined; }
export type TrajectoryActionResult = { readonly id: string; readonly state: "running" };
export type TrajectoryActionHandler = (request: Readonly<TrajectoryActionRequest>) => Promise<void> | Promise<TrajectoryActionResult | undefined>;
export type TrajectoryRunLoader = () => Promise<readonly TrajectoryRun[]>;

export type TrajectoryPublisherInput = {
  cwd: string;
  sessionId: string;
  port?: number;
  themes: boolean;
  loadRuns: TrajectoryRunLoader;
  loadSubagents: TrajectorySubagentLoader;
  handleAction: TrajectoryActionHandler;
};

type TrajectoryPublisherClient = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: unknown) => void): void;
};

type TrajectoryPublisherConstructor = new (url: string) => TrajectoryPublisherClient;

type TrajectoryLock = { pid: number; port: number; fingerprint?: string };
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
async function trajectoryFingerprint(serverPath: string): Promise<string> {
  const [serverBytes, htmlBytes] = await Promise.all([readFile(serverPath), readFile(join(dirname(serverPath), "trajectory/index.html"))]);
  return `${createHash("sha256").update(serverBytes).digest("hex")}:${createHash("sha256").update(htmlBytes).digest("hex")}`;
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    throw error;
  }
}
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
}
async function stopStaleServer(lock: TrajectoryLock): Promise<void> {
  // During startup, the lock can name the current Pi process rather than the detached server.
  if (lock.pid === process.pid) return;
  signalProcess(lock.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!await serverHealthy(lock.port)) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(50, remaining));
  }
  if (processAlive(lock.pid)) signalProcess(lock.pid, "SIGKILL");
}

async function readLock(path: string): Promise<TrajectoryLock | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(parsed) || !positiveInteger(parsed.pid) || !positiveInteger(parsed.port) || parsed.port > 65535) return undefined;
    const fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined;
    return { pid: parsed.pid, port: parsed.port, ...(fingerprint === undefined ? {} : { fingerprint }) };
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
async function resolveExistingServer(lockPath: string, existing: TrajectoryLock, fingerprint: string): Promise<TrajectoryLock | undefined> {
  if (await serverHealthy(existing.port)) {
    if (existing.fingerprint === fingerprint) return existing;
    await stopStaleServer(existing);
    await rm(lockPath, { force: true });
    return undefined;
  }
  if (processAlive(existing.pid)) {
    try {
      await waitForServer(existing.port);
      return existing;
    } catch {
      // A live lock can still name the attaching process during startup; after the bounded wait, replace the unrecoverable startup owner and retry normally.
      await stopStaleServer(existing);
      await rm(lockPath, { force: true });
      return undefined;
    }
  }
  await rm(lockPath, { force: true });
  return undefined;
}

async function ensureTrajectoryServer(agentDir: string, configuredPort: number): Promise<{ port: number }> {
  const lockPath = trajectoryLockPath(agentDir);
  const serverPath = trajectoryServerPath();
  const fingerprint = await trajectoryFingerprint(serverPath);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const existing = await readLock(lockPath);
  if (existing) {
    const reused = await resolveExistingServer(lockPath, existing, fingerprint);
    if (reused) return reused;
  }
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, port: configuredPort, fingerprint })}\n`, "utf8");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      const raced = await readLock(lockPath);
      if (raced) {
        const reused = await resolveExistingServer(lockPath, raced, fingerprint);
        if (reused) return reused;
      }
      await rm(lockPath, { force: true });
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, port: configuredPort, fingerprint })}\n`, "utf8");
    } else {
      throw error;
    }
  } finally { await lockHandle?.close(); }
  try {
    const child = spawn(process.execPath, [serverPath, "--port", String(configuredPort), "--lock", lockPath, "--fingerprint", fingerprint], { detached: true, stdio: "ignore" });
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
function toolDefinitionsFor(tools: readonly string[], catalog: ReadonlyMap<string, string>): readonly { readonly name: string; readonly description: string }[] {
  return tools.flatMap((name) => {
    const description = catalog.get(name);
    return description ? [{ name, description }] : [];
  });
}
export function applyToolDescriptions(run: PersistedRun, catalog: ReadonlyMap<string, string>): PersistedRun {
  const agents = run.agents.map((agent) => {
    if (agent.toolDefinitions?.length) return agent;
    const toolDefinitions = toolDefinitionsFor(agent.tools, catalog);
    if (!toolDefinitions.length) return agent;
    return { ...agent, toolDefinitions };
  });
  if (agents.every((agent, index) => agent === run.agents[index])) return run;
  return { ...run, agents };
}

function piToolCatalog(cwd = process.cwd()): ReadonlyMap<string, string> {
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
export function withPiToolDescriptionsForTools(tools: readonly string[], cwd: string): readonly { readonly name: string; readonly description: string }[] {
  return toolDefinitionsFor(tools, piToolCatalog(cwd));
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

type DiscoveredResources = { skills: readonly string[]; extensions: readonly string[] };
const discoveredResourcesByCwd = new Map<string, Promise<DiscoveredResources>>();
async function discoveredResources(cwd: string): Promise<DiscoveredResources> {
  const cached = discoveredResourcesByCwd.get(cwd);
  if (cached) return cached;
  const pending = (async (): Promise<DiscoveredResources> => {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    return {
      extensions: [...new Set(resolved.extensions.filter((entry) => entry.enabled).map((entry) => canonicalSourcePath(entry.path)))],
      skills: [...new Set(resolved.skills.filter((entry) => entry.enabled).map((entry) => skillNameFromPath(entry.path)))],
    };
  })();
  discoveredResourcesByCwd.set(cwd, pending);
  // A cached rejection would keep the fallback empty for the rest of the process lifetime.
  pending.catch(() => discoveredResourcesByCwd.delete(cwd));
  return pending;
}
type ResourceInspection = NonNullable<AgentAttemptSummary["setup"]["resourceSelectors"]>;
async function resolveResourceInspection(inspection: ResourceInspection | undefined, cwd: string, selectorCwd = cwd): Promise<ResourceInspection | undefined> {
  if (!inspection || inspection.skills.length && inspection.extensions.length) return inspection;
  let discovered: DiscoveredResources;
  try { discovered = await discoveredResources(cwd); } catch { return inspection; }
  const sources = inspection.selectorSources ?? { global: inspection.selectors, project: {} };
  const skills = inspection.skills.length ? inspection.skills : selectResourcesByLayers([sources.global.skills, sources.project.skills, sources.role?.skills, sources.call?.skills], discovered.skills);
  const extensions = inspection.extensions.length ? inspection.extensions : selectResourcesByLayers([sources.global.extensions, sources.project.extensions, sources.role?.extensions, sources.call?.extensions].map((layer) => layer?.map((selector) => canonicalExtensionSelector(selector, selectorCwd))), discovered.extensions);
  return skills === inspection.skills && extensions === inspection.extensions ? inspection : { ...inspection, skills, extensions };
}
export async function withResolvedAttemptResources(attempt: AgentAttemptSummary, cwd: string): Promise<AgentAttemptSummary> {
  const resourceSelectors = await resolveResourceInspection(attempt.setup.resourceSelectors, cwd, attempt.setup.cwd || cwd);
  if (resourceSelectors === attempt.setup.resourceSelectors) return attempt;
  return { ...attempt, setup: { ...attempt.setup, ...(resourceSelectors === undefined ? {} : { resourceSelectors }) } };
}
export async function withResolvedResources(run: PersistedRun, cwd: string): Promise<PersistedRun> {
  const agents = await Promise.all(run.agents.map(async (agent) => {
    const details = agent.attemptDetails;
    const last = details?.at(-1);
    if (!details || !last) return agent;
    const resourceSelectors = await resolveResourceInspection(last.setup.resourceSelectors, cwd, last.setup.cwd || cwd);
    if (resourceSelectors === last.setup.resourceSelectors) return agent;
    return { ...agent, attemptDetails: [...details.slice(0, -1), { ...last, setup: { ...last.setup, ...(resourceSelectors === undefined ? {} : { resourceSelectors }) } }] };
  }));
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
type CachedTrajectorySubagent = { value: TrajectorySubagent; fileMtimes: ReadonlyMap<string, number | undefined>; transcriptMtime: number | undefined };
const TRAJECTORY_SUBAGENT_FILES = ["status.json", "request.json", "result.json", "failure.json"] as const;
const TRAJECTORY_SUBAGENT_ATTENTION_ORDER: Readonly<Record<SubagentStatus["state"], number>> = { running: 0, failed: 1, stopped: 2, completed: 3 };
async function readSubagentJson(path: string, optional = false, maxBytes?: number): Promise<unknown> {
  try {
    if (maxBytes !== undefined) { const info = await stat(path); if (!info.isFile() || info.size > maxBytes) return undefined; }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }
  catch (error) { if (optional && isNodeError(error, "ENOENT")) return undefined; throw error; }
}
async function subagentFileBytes(path: string): Promise<number | undefined> {
  try { const info = await stat(path); return info.isFile() ? info.size : undefined; } catch { return undefined; }
}
function subagentArtifact(path: string, bytes: number | undefined): TrajectorySubagentArtifact | undefined { return bytes === undefined ? undefined : { truncated: true, path, bytes }; }
function boundedSubagentJson(value: unknown): JsonValue | undefined { return jsonValue(value) ? value : undefined; }
async function loadTrajectorySubagent(directory: string, cwd: string, sessionId: string): Promise<TrajectorySubagent | "foreign" | undefined> {
  try {
    const id = basename(directory);
    const status = statusValue(await readSubagentJson(join(directory, "status.json")));
    if (!status || status.id !== id) return undefined;
    if (status.sessionId !== sessionId) return "foreign";
    const request = normalizeSubagentRunRequest(await readSubagentJson(join(directory, "request.json")));
    const resultPath = join(directory, "result.json");
    const failurePath = join(directory, "failure.json");
    const resultBytes = await subagentFileBytes(resultPath);
    const failureBytes = await subagentFileBytes(failurePath);
    const resultValue = await readSubagentJson(resultPath, true, DEFAULT_MAX_BYTES);
    const failureValue = await readSubagentJson(failurePath, true, DEFAULT_MAX_BYTES);
    const resultTruncated = resultValue === undefined && resultBytes !== undefined && resultBytes > DEFAULT_MAX_BYTES;
    const failureTruncated = failureValue === undefined && failureBytes !== undefined && failureBytes > DEFAULT_MAX_BYTES;
    if (!resultTruncated && resultValue !== undefined && boundedSubagentJson(resultValue) === undefined || !failureTruncated && failureValue !== undefined && subagentErrorValue(failureValue) === undefined) return undefined;
    const resultArtifact = resultTruncated ? subagentArtifact(resultPath, resultBytes) : undefined;
    const failureArtifact = failureTruncated ? subagentArtifact(failurePath, failureBytes) : undefined;
    const result = resultArtifact ?? (resultValue === undefined ? undefined : boundedSubagentJson(resultValue));
    const failure = failureArtifact ?? (failureValue === undefined ? undefined : subagentErrorValue(failureValue));
    const rawAttempt = status.attemptDetails?.at(-1);
    const attempt = rawAttempt === undefined ? undefined : await withResolvedAttemptResources(rawAttempt, cwd);
    const tools = status.progress?.state?.tools ?? attempt?.setup.tools ?? [];
    const toolDefinitions = toolDefinitionsFor(tools, piToolCatalog(cwd));
    const model = status.progress?.state?.model ?? attempt?.setup.model;
    const transcriptPath = sessionFile(attempt?.session);
    const transcript = transcriptPath === undefined ? [] : await readTranscript(transcriptPath);
    return {
      id, sessionId, cwd, mode: request.mode ?? "background", state: status.state, request, tools, transcript,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
      ...(status.finishedAt === undefined ? {} : { finishedAt: status.finishedAt }),
      ...(status.attempts === undefined ? {} : { attempts: status.attempts }),
      ...(status.error === undefined ? {} : { error: status.error }),
      ...(status.worktree === undefined ? {} : { worktree: status.worktree }),
      ...(model === undefined ? {} : { model }),
      ...(toolDefinitions.length ? { toolDefinitions } : {}),
      ...(status.progress === undefined ? {} : { progress: status.progress }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(result === undefined ? {} : { result }),
      ...(failure === undefined ? {} : { failure }),
    };
  } catch { return undefined; }
}
async function subagentCacheEntryChanged(directory: string, entry: CachedTrajectorySubagent): Promise<boolean> {
  for (const file of TRAJECTORY_SUBAGENT_FILES) if (await fileMtime(join(directory, file)) !== entry.fileMtimes.get(file)) return true;
  const transcriptPath = sessionFile(entry.value.attempt?.session);
  return transcriptPath !== undefined && await fileMtime(transcriptPath) !== entry.transcriptMtime;
}
export function createTrajectorySubagentLoader(cwd: string, sessionId: string, agentDir: string, overlay?: (subagent: TrajectorySubagent) => TrajectorySubagent): TrajectorySubagentLoader {
  const root = join(agentDir, "subagents");
  const cache = new Map<string, CachedTrajectorySubagent>();
  const negativeCache = new Map<string, number | undefined>();
  return async () => {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
    const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const current = new Set(ids);
    for (const id of cache.keys()) if (!current.has(id)) cache.delete(id);
    for (const id of negativeCache.keys()) if (!current.has(id)) negativeCache.delete(id);
    const loaded: TrajectorySubagent[] = [];
    for (const id of ids) {
      const directory = join(root, id);
      const statusPath = join(directory, "status.json");
      try {
        const statusMtime = await fileMtime(statusPath);
        if (negativeCache.has(id) && negativeCache.get(id) === statusMtime) continue;
        negativeCache.delete(id);
        let entry = cache.get(id);
        if (!entry || await subagentCacheEntryChanged(directory, entry)) {
          const value = await loadTrajectorySubagent(directory, cwd, sessionId);
          if (value === "foreign") { cache.delete(id); negativeCache.set(id, statusMtime); continue; }
          if (!value) { cache.delete(id); continue; }
          const fileMtimes = new Map<string, number | undefined>();
          for (const file of TRAJECTORY_SUBAGENT_FILES) fileMtimes.set(file, await fileMtime(join(directory, file)));
          const transcriptPath = sessionFile(value.attempt?.session);
          entry = { value, fileMtimes, transcriptMtime: transcriptPath === undefined ? undefined : await fileMtime(transcriptPath) };
          cache.set(id, entry);
        }
        loaded.push(overlay ? overlay(entry.value) : entry.value);
      } catch { cache.delete(id); /* Ignore corrupt or concurrently removed subagents. */ }
    }
    const attention = navigatorAttentionSortByState(loaded, (entry) => entry.state, () => undefined, TRAJECTORY_SUBAGENT_ATTENTION_ORDER);
    return attention.sort((left, right) => {
      if (left.state !== right.state) return 0;
      const leftTime = left.finishedAt ?? left.startedAt ?? -1;
      const rightTime = right.finishedAt ?? right.startedAt ?? -1;
      return rightTime - leftTime || left.id.localeCompare(right.id);
    });
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
      const subagents = await input.loadSubagents();
      if (closing || socket !== activeSocket) return;
      const state = { type: "publisher:state", publisher: { id: publisherId(input.cwd, input.sessionId), title: `session ${input.sessionId.slice(0, 8)}`, cwd: input.cwd, sessionId: input.sessionId, themes: input.themes }, runs, subagents };
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
        if (!isTrajectoryTarget(message.target)) { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: "Invalid Trajectory action target" })); return; }
        const target = message.target;
        const actionError = trajectoryActionError(message.action, target);
        if (actionError !== undefined) { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: actionError })); return; }
        void input.handleAction({ action: message.action, target, ...(typeof message.name === "string" ? { name: message.name } : {}), ...(message.payload === undefined ? {} : { payload: message.payload }) }).then((result) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: true, ...(result === undefined ? {} : { result }) })); }, (error: unknown) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: errorText(error) })); }).catch(() => undefined);
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
