import assert from "node:assert/strict";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
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
  assert.ok(data.length < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.alloc(data.length + 6);
  frame[0] = 0x81;
  frame[1] = 0x80 | data.length;
  mask.copy(frame, 2);
  for (let index = 0; index < data.length; index += 1) frame[index + 6] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return frame;
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
