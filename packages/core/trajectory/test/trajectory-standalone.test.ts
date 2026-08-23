import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

async function availablePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

async function waitForHealth(port: number, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) })).ok) return;
    } catch { /* The child is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Trajectory server did not start: ${stderr.join("")}`);
}

void test("Trajectory detached server starts without Pi module resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-standalone-"));
  const port = await availablePort();
  const serverPath = join(root, "dist", "trajectory", "src", "server.js");
  const contractsPath = join(root, "dist", "src", "trajectory-contracts.js");
  await mkdir(join(root, "dist", "trajectory", "src"), { recursive: true });
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await copyFile(fileURLToPath(new URL("../src/server.js", import.meta.url)), serverPath);
  await copyFile(fileURLToPath(new URL("../../src/trajectory-contracts.js", import.meta.url)), contractsPath);

  const stderr: string[] = [];
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--lock", join(root, "trajectory.lock"), "--fingerprint", "test"], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr.push(chunk); });
  try {
    await waitForHealth(port, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
    }
    await rm(root, { recursive: true, force: true });
  }
});
