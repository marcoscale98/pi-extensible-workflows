import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { isTrajectoryAction, isTrajectoryTarget, trajectoryActionError, withPiToolDescriptions, withPiToolDescriptionsForTools, withResolvedAttemptResources, withResolvedResources } from "../../src/trajectory.js";
import type { AgentAttemptSummary } from "../../src/types.js";
import type { PersistedRun } from "../../src/persistence.js";
const TRAJECTORY_IDLE_EXIT_MS = 5 * 60 * 1000;

type Socket = import("node:stream").Duplex;
type ClientKind = "publisher" | "browser";
type Client = { socket: Socket; kind: ClientKind; publisherId?: string; buffer: Buffer; pendingState: Buffer | undefined; backpressured: boolean };
type State = { type: "state"; publishers: readonly unknown[]; updatedAt: number; initial?: boolean; truncated?: boolean };
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const TIMING_ENTRY_TYPE = "pi-workflows:tool-timing";

function isTimingEntry(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "custom" && (value as { customType?: unknown }).customType === TIMING_ENTRY_TYPE);
}

function compactRun(run: unknown): unknown {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const record = run as { transcripts?: unknown };
  if (!record.transcripts || typeof record.transcripts !== "object" || Array.isArray(record.transcripts)) return { ...record, transcripts: {} };
  const transcripts: Record<string, unknown[]> = {};
  for (const [id, entries] of Object.entries(record.transcripts as Record<string, unknown>)) transcripts[id] = Array.isArray(entries) ? entries.filter(isTimingEntry) : [];
  return { ...record, transcripts };
}
function compactSubagent(subagent: unknown): unknown {
  if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) return subagent;
  const record = subagent as { transcript?: unknown };
  return { ...record, transcript: Array.isArray(record.transcript) ? record.transcript.filter(isTimingEntry) : [] };
}

function compactPublishers(publishers: readonly unknown[]): unknown[] {
  return publishers.map((publisher) => {
    if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) return publisher;
    const value = publisher as { runs?: unknown; subagents?: unknown };
    return { ...value, ...(Array.isArray(value.runs) ? { runs: value.runs.map(compactRun) } : {}), ...(Array.isArray(value.subagents) ? { subagents: value.subagents.map(compactSubagent) } : {}) };
  });
}

function encodeState(state: State, maxBytes: number): string {
  const full = JSON.stringify(state);
  if (Buffer.byteLength(full) <= maxBytes) return full;
  // ponytail: strip message transcripts when combined state exceeds the frame cap; ui:transcript loads one agent
  const compact = JSON.stringify({ type: "state", publishers: compactPublishers(state.publishers), updatedAt: state.updatedAt });
  if (Buffer.byteLength(compact) <= maxBytes) return compact;
  return JSON.stringify({ type: "state", publishers: [], updatedAt: state.updatedAt, truncated: true });
}

async function withDescribedRuns(runs: unknown): Promise<unknown[]> {
  if (!Array.isArray(runs)) return [];
  const items: unknown[] = runs;
  return Promise.all(items.map(async (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("run" in item)) return item;
    const record = item as { run: PersistedRun };
    const run = record.run;
    const cwd = run.agents.at(0)?.attemptDetails?.at(-1)?.setup.cwd ?? process.cwd();
    return { ...record, run: await withResolvedResources(withPiToolDescriptions(run), cwd) };
  }));
}
async function withDescribedSubagents(subagents: unknown): Promise<unknown[]> {
  if (!Array.isArray(subagents)) return [];
  const items: unknown[] = subagents;
  return Promise.all(items.map(async (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("attempt" in item)) return item;
    const record = item as { attempt: AgentAttemptSummary; cwd?: unknown; tools?: unknown; toolDefinitions?: unknown };
    const cwd = typeof record.cwd === "string" ? record.cwd : record.attempt.setup.cwd;
    const attempt = await withResolvedAttemptResources(record.attempt, cwd);
    const tools = Array.isArray(record.tools) ? record.tools.filter((tool): tool is string => typeof tool === "string") : attempt.setup.tools;
    const toolDefinitions = withPiToolDescriptionsForTools(tools, cwd);
    const hasToolDefinitions = Array.isArray(record.toolDefinitions) && record.toolDefinitions.length > 0;
    return { ...record, attempt, ...(!hasToolDefinitions && toolDefinitions.length ? { toolDefinitions } : {}) };
  }));
}
function frame(payload: string, maxBytes: number): Buffer {
  const body = Buffer.from(payload);
  if (body.length > maxBytes) throw new Error("Trajectory WebSocket frame is too large");
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length <= 0xffff) { const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); return Buffer.concat([header, body]); }
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); return Buffer.concat([header, body]);
}

function isState(value: unknown): value is State {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "state");
}

function writeFrame(client: Client, packet: Buffer, state: boolean): void {
  if (state && client.backpressured) { client.pendingState = packet; return; }
  try {
    if (state) client.pendingState = undefined;
    if (!client.socket.write(packet)) client.backpressured = true;
  } catch { client.socket.destroy(); }
}

function send(client: Client, value: unknown, maxBytes: number): void {
  try {
    const state = isState(value);
    const packet = frame(state ? encodeState(value, maxBytes) : JSON.stringify(value), maxBytes);
    writeFrame(client, packet, state);
  } catch { client.socket.destroy(); }
}

function parseFrames(client: Client, chunk: Buffer, maxBytes: number): readonly string[] {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  if (client.buffer.length > maxBytes + 14) throw new Error("Trajectory WebSocket buffer is too large");
  const messages: string[] = [];
  while (client.buffer.length >= 2) {
    const first = client.buffer[0] ?? 0;
    const second = client.buffer[1] ?? 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if ((first & 0x70) !== 0 || (first & 0x80) === 0 || !masked) throw new Error("Invalid Trajectory WebSocket frame");
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) { if (client.buffer.length < 4) break; length = client.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (client.buffer.length < 10) break; const longLength = client.buffer.readBigUInt64BE(2); if (longLength > BigInt(maxBytes)) throw new Error("Trajectory WebSocket frame is too large"); length = Number(longLength); offset = 10; }
    if (opcode >= 0x8 && (length > 125 || (first & 0x80) === 0)) throw new Error("Invalid Trajectory WebSocket control frame");
    if (client.buffer.length < offset + 4 + length) break;
    const mask = client.buffer.subarray(offset, offset + 4); offset += 4;
    const data = client.buffer.subarray(offset, offset + length);
    client.buffer = client.buffer.subarray(offset + length);
    if (opcode === 0x8) { client.socket.end(); break; }
    if (opcode === 0x9) { const pong = Buffer.alloc(2 + length); pong[0] = 0x8a; pong[1] = length; for (let index = 0; index < length; index += 1) pong[index + 2] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0); writeFrame(client, pong, false); continue; }
    if (opcode === 0xA) continue;
    if (opcode !== 0x1) throw new Error("Unsupported Trajectory WebSocket frame");
    const decoded = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) decoded[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
    messages.push(decoded.toString("utf8"));
  }
  return messages;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}
function authorized(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://127.0.0.1:${String(port)}` || origin === `http://localhost:${String(port)}`;
}

type TrajectoryServerOptions = { maxFrameBytes?: number; fingerprint?: string };
export function createTrajectoryServer(port: number, lockPath: string, options: TrajectoryServerOptions = {}): Server {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const serverFingerprint = options.fingerprint ?? "";
  const clients = new Set<Client>();
  const publishers = new Map<string, { client: Client; value: Record<string, unknown>; sequence: number }>();
  let latest: State = { type: "state", publishers: [], updatedAt: Date.now(), initial: true };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const emit = (client: Client, value: unknown) => { send(client, value, maxFrameBytes); };
  const scheduleIdleExit = () => {
    if (closed || [...publishers.values()].some(({ value }) => value.connected === true) || idleTimer !== undefined) return;
    idleTimer = setTimeout(() => {
      server.closeAllConnections();
      for (const client of clients) client.socket.destroy();
      server.close(() => {
        void rm(lockPath, { force: true }).then(() => { process.exit(0); }).catch(() => { process.exit(1); });
      });
    }, TRAJECTORY_IDLE_EXIT_MS);
    idleTimer.unref();
  };
  const cancelIdleExit = () => {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
  };
  const broadcast = (value: unknown) => {
    if (isState(value)) {
      try {
        const stateFrame = frame(encodeState(value, maxFrameBytes), maxFrameBytes);
        for (const client of clients) if (client.kind === "browser") writeFrame(client, stateFrame, true);
      } catch {
        for (const client of clients) if (client.kind === "browser") client.socket.destroy();
      }
      return;
    }
    for (const client of clients) if (client.kind === "browser") emit(client, value);
  };
  const publishState = () => {
    const values = [...publishers.values()].map(({ value }) => value);
    latest = { type: "state", publishers: values, updatedAt: Date.now() };
    broadcast(latest);
  };
  const disconnect = (client: Client) => {
    clients.delete(client);
    if (client.kind === "publisher" && client.publisherId && publishers.get(client.publisherId)?.client === client) {
      publishers.delete(client.publisherId);
      publishState();
      scheduleIdleExit();
    }
  };
  const handleMessage = (client: Client, raw: string) => {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.type === "ui:attach") { client.kind = "browser"; emit(client, latest); return; }
    if (client.kind === "publisher" && message.type === "publisher:attach" && typeof message.publisherId === "string") {
      cancelIdleExit();
      client.publisherId = message.publisherId;
      const previous = publishers.get(message.publisherId);
      const sequence = (previous?.sequence ?? 0) + 1;
      publishers.set(message.publisherId, { client, value: { ...(previous?.value ?? { id: message.publisherId }), id: message.publisherId, connected: true }, sequence });
      publishState();
      return;
    }
    if (client.kind === "publisher" && message.type === "publisher:state" && typeof message.publisher === "object" && message.publisher !== null) {
      const publisher = message.publisher as Record<string, unknown>;
      const id = typeof publisher.id === "string" ? publisher.id : client.publisherId;
      if (!id) return;
      client.publisherId = id;
      cancelIdleExit();
      const previous = publishers.get(id);
      const sequence = (previous?.sequence ?? 0) + 1;
      publishers.set(id, { client, value: { ...(previous?.value ?? { id }), ...publisher, connected: true }, sequence });
      void Promise.all([withDescribedRuns(message.runs), withDescribedSubagents(message.subagents)]).then(([runs, subagents]) => {
        if (client.publisherId !== id || publishers.get(id)?.client !== client || publishers.get(id)?.sequence !== sequence) return;
        publishers.set(id, { client, value: { ...publisher, connected: true, runs, subagents }, sequence });
        publishState();
      }, () => {
        if (client.publisherId !== id || publishers.get(id)?.client !== client || publishers.get(id)?.sequence !== sequence) return;
        publishers.set(id, { client, value: { ...publisher, connected: true, runs: Array.isArray(message.runs) ? message.runs : [], subagents: Array.isArray(message.subagents) ? message.subagents : [] }, sequence });
        publishState();
      });
      return;
    }
    if (client.kind === "publisher" && message.type === "publisher:action-result" && typeof message.requestId === "string") { broadcast(message); return; }
    if (client.kind === "browser" && message.type === "ui:transcript") {
      const validId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;
      if (!validId(message.publisherId)) return;
      const runRequest = validId(message.runId) && validId(message.agentId) && message.subagentId === undefined;
      const subagentRequest = validId(message.subagentId) && message.runId === undefined && message.agentId === undefined;
      if (!runRequest && !subagentRequest) return;
      const target = publishers.get(message.publisherId);
      let entries: unknown[] = [];
      if (runRequest) {
        const runs = target?.value.runs;
        if (Array.isArray(runs)) {
          for (const item of runs) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const record = item as { run?: { id?: unknown }; transcripts?: unknown };
            if (record.run?.id !== message.runId) continue;
            const transcripts = record.transcripts;
            if (transcripts && typeof transcripts === "object" && !Array.isArray(transcripts)) {
              const found = (transcripts as Record<string, unknown>)[message.agentId as string];
              entries = Array.isArray(found) ? found : [];
            }
            break;
          }
        }
      } else {
        const subagents = target?.value.subagents;
        if (Array.isArray(subagents)) {
          for (const item of subagents) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const record = item as { id?: unknown; transcript?: unknown };
            if (record.id !== message.subagentId) continue;
            entries = Array.isArray(record.transcript) ? record.transcript : [];
            break;
          }
        }
      }
      const reply = runRequest ? { type: "transcript", publisherId: message.publisherId, runId: message.runId, agentId: message.agentId, entries } : { type: "transcript", publisherId: message.publisherId, subagentId: message.subagentId, entries };
      if (Buffer.byteLength(JSON.stringify(reply)) > maxFrameBytes) {
        emit(client, runRequest ? { type: "transcript", publisherId: message.publisherId, runId: message.runId, agentId: message.agentId, ok: false, error: "Transcript is too large" } : { type: "transcript", publisherId: message.publisherId, subagentId: message.subagentId, ok: false, error: "Transcript is too large" });
        return;
      }
      emit(client, reply);
      return;
    }
    if (client.kind !== "browser" || message.type !== "ui:action" || typeof message.publisherId !== "string") return;
    const requestId = typeof message.requestId === "string" ? message.requestId : randomUUID();
    if (!isTrajectoryAction(message.action)) { emit(client, { type: "action-result", requestId, ok: false, error: "Unsupported Trajectory action" }); return; }
    if (!isTrajectoryTarget(message.target)) { emit(client, { type: "action-result", requestId, ok: false, error: "Invalid Trajectory action target" }); return; }
    const actionError = trajectoryActionError(message.action, message.target);
    if (actionError !== undefined) { emit(client, { type: "action-result", requestId, ok: false, error: actionError }); return; }
    const target = publishers.get(message.publisherId);
    if (!target || !target.value.connected) { emit(client, { type: "action-result", requestId, ok: false, error: "Publisher is disconnected" }); return; }
    emit(target.client, { type: "publisher:action", requestId, action: message.action, target: message.target, ...(typeof message.name === "string" ? { name: message.name } : {}), ...(message.payload === undefined ? {} : { payload: message.payload }) });
  };
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`); }
    catch { writeJson(response, 400, { error: "Invalid request" }); return; }
    if (!authorized(request, port)) { writeJson(response, 403, { error: "Forbidden" }); return; }
    const path = url.pathname;
    if (request.method === "GET" && path === "/health") { writeJson(response, 200, { ok: true }); return; }
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      void readFile(new URL("./assets/index.html", import.meta.url)).then((html) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.byteLength, "cache-control": "no-store" });
        response.end(html);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory UI is unavailable" }); });
      return;
    }
    if (request.method === "GET" && path === "/marked.min.js") {
      void readFile(new URL("./assets/marked.min.js", import.meta.url)).then((script) => {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": script.byteLength, "cache-control": "no-store" });
        response.end(script);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory markdown renderer is unavailable" }); });
      return;
    }
    if (request.method === "GET" && path === "/morphdom.min.js") {
      void readFile(new URL("./assets/morphdom.min.js", import.meta.url)).then((script) => {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": script.byteLength, "cache-control": "no-store" });
        response.end(script);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory DOM diffing library is unavailable" }); });
      return;
    }
    if (request.method === "GET" && (path === "/favicon.png" || path === "/favicon.ico")) {
      void readFile(new URL("./assets/favicon.png", import.meta.url)).then((icon) => {
        response.writeHead(200, { "content-type": "image/png", "content-length": icon.byteLength, "cache-control": "no-store" });
        response.end(icon);
      }).catch(() => { writeJson(response, 404, { error: "Not found" }); });
      return;
    }
    writeJson(response, 404, { error: "Not found" });
  });
  server.on("upgrade", (request, socket) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`); }
    catch { socket.destroy(); return; }
    const key = request.headers["sec-websocket-key"];
    if (!authorized(request, port) || url.pathname !== "/ws" || typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client: Client = { socket, kind: "publisher", buffer: Buffer.alloc(0), pendingState: undefined, backpressured: false };
    socket.on("drain", () => {
      const pendingState = client.pendingState;
      client.pendingState = undefined;
      client.backpressured = false;
      if (pendingState !== undefined) writeFrame(client, pendingState, true);
    });
    clients.add(client);
    socket.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) return;
      try { for (const message of parseFrames(client, chunk, maxFrameBytes)) handleMessage(client, message); } catch { socket.destroy(); }
    });
    socket.on("close", () => { disconnect(client); });
    socket.on("error", () => { disconnect(client); });
  });
  server.once("listening", () => { void writeFile(lockPath, `${JSON.stringify({ pid: process.pid, port, fingerprint: serverFingerprint })}\n`, { mode: 0o600 }).catch(() => { process.exitCode = 1; }); scheduleIdleExit(); });
  server.on("close", () => { closed = true; if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; } });
  return server;
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 2; index + 1 < process.argv.length; index += 2) args.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
  const port = Number(args.get("--port"));
  const lockPath = args.get("--lock");
  const fingerprint = args.get("--fingerprint");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !lockPath || !fingerprint) throw new Error("Invalid Trajectory server arguments");
  const server = createTrajectoryServer(port, lockPath, { fingerprint });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { resolve(); }); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
