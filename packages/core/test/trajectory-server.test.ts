import assert from "node:assert/strict";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrajectoryServer } from "../src/trajectory-server.js";

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

async function listen(server: ReturnType<typeof createTrajectoryServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}

function maskedFrame(value: string): Buffer {
  const data = Buffer.from(value);
  const mask = Buffer.from([1, 2, 3, 4]);
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const body = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) body[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, body]);
}

function maskedCloseFrame(): Buffer {
  return Buffer.from([0x88, 0x80, 1, 2, 3, 4]);
}

function decodeTextFrame(buffer: Buffer): { payload: string } | undefined {
  if (buffer.length < 2) return undefined;
  const second = buffer[1] ?? 0;
  assert.equal(second & 0x80, 0);
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return undefined;
  return { payload: buffer.subarray(offset, offset + length).toString("utf8") };
}

async function readJsonFrame(socket: Socket): Promise<unknown> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("timed out waiting for Trajectory frame")); }, 2000);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeTextFrame(buffer);
      if (!decoded) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(JSON.parse(decoded.payload));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function publisherState(id: string, blob: string): string {
  return JSON.stringify({
    type: "publisher:state",
    publisher: { id },
    runs: [{ run: { id, workflowName: id, agents: [], state: "completed" }, transcripts: { agent: [{ type: "message", text: blob }] }, snapshot: {}, awaiting: [] }],
  });
}

async function handshake(port: number, origin: string): Promise<{ socket: Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ socket, response: data });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  });
}

void test("Trajectory persists the server fingerprint in its listening lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-lock-"));
  const port = await availablePort();
  const fingerprint = "server-hash:html-hash";
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), fingerprint);
  await listen(server, port);
  try {
    assert.deepEqual(JSON.parse(await readFile(join(root, "trajectory.lock"), "utf8")), { pid: process.pid, port, fingerprint });
  } finally {
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory HTTP and WebSocket boundaries require localhost and origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  try {
    const base = `http://127.0.0.1:${String(port)}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { host: `localhost:${String(port)}` } })).status, 200);
    assert.equal((await fetch(`${base}/health?token=ignored`)).status, 200);
    for (const path of ["/", "/index.html", "/marked.min.js"]) assert.equal((await fetch(`${base}${path}`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { origin: "http://evil.test" } })).status, 403);
    const valid = await handshake(port, `http://127.0.0.1:${String(port)}`);
    assert.match(valid.response, /^HTTP\/1\.1 101 Switching Protocols/);
    const state = new Promise<Buffer>((resolve) => valid.socket.once("data", resolve));
    valid.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.ok((await state).length > 2);
    valid.socket.destroy();
    const invalidOrigin = await new Promise<string>((resolve) => {
      const socket = createConnection(port, "127.0.0.1");
      let response = "";
      socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
      socket.once("close", () => { resolve(response); });
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://evil.test\r\n\r\n`);
    });
    assert.doesNotMatch(invalidOrigin, /101 Switching Protocols/);
    const unmasked = await handshake(port, `http://127.0.0.1:${String(port)}`);
    const closed = new Promise<void>((resolve) => unmasked.socket.once("close", () => { resolve(); }));
    unmasked.socket.write(Buffer.from([0x81, 1, 0x78]));
    await closed;
  } finally {
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory keeps the browser socket when combined publisher state exceeds the frame cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-cap-"));
  const port = await availablePort();
  const maxFrameBytes = 800;
  const blob = "x".repeat(400);
  const first = publisherState("one", blob);
  const second = publisherState("two", blob);
  assert.ok(Buffer.byteLength(first) < maxFrameBytes);
  assert.ok(Buffer.byteLength(second) < maxFrameBytes);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), maxFrameBytes);
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(first));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(second));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const closed = new Promise<string>((resolve) => browser.socket.once("close", () => { resolve("closed"); }));
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const message = await Promise.race([state, closed.then((value) => { throw new Error(value); })]);
    assert.equal((message as { type?: unknown }).type, "state");
    const publishers = (message as { publishers?: unknown[] }).publishers;
    assert.ok(Array.isArray(publishers));
    assert.equal(publishers.length, 2);
    for (const publisher of publishers) {
      const runs = (publisher as { runs?: { transcripts?: { agent?: unknown[] } }[] }).runs;
      assert.deepEqual(runs?.[0]?.transcripts?.agent ?? [], []);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory removes disconnected publishers from browser state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-disconnect-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(publisherState("one", "one")));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(publisherState("two", "two")));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const initial = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const firstState = await initial as { publishers?: { id?: unknown }[] };
    assert.deepEqual(firstState.publishers?.map((publisher) => publisher.id), ["one", "two"]);

    const nextState = readJsonFrame(browser.socket);
    publisherOne.socket.write(maskedCloseFrame());
    const afterDisconnect = await nextState as { publishers: { id?: unknown; connected?: unknown }[] };
    assert.deepEqual(afterDisconnect.publishers.map((publisher) => publisher.id), ["two"]);
    assert.equal(afterDisconnect.publishers.some((publisher) => publisher.connected === false), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory fetches one agent transcript after compacting combined state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-transcript-"));
  const port = await availablePort();
  const maxFrameBytes = 800;
  const blob = "x".repeat(400);
  const first = publisherState("one", blob);
  const second = publisherState("two", blob);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), maxFrameBytes);
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(first));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(second));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const compact = await state as { publishers?: { runs?: { transcripts?: { agent?: unknown[] } }[] }[] };
    assert.deepEqual(compact.publishers?.[0]?.runs?.[0]?.transcripts?.agent ?? [], []);
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", runId: "one", agentId: "agent" })));
    const transcript = await reply as { type?: unknown; agentId?: unknown; entries?: unknown };
    assert.equal(transcript.type, "transcript");
    assert.equal(transcript.agentId, "agent");
    assert.deepEqual(transcript.entries, [{ type: "message", text: blob }]);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
