import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(resolve(tmpdir(), "piewf-packages-"));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(work, "tarballs");
const agentRoot = resolve(work, "agent");
const installRoot = resolve(agentRoot, "npm");
const workspaces = ["packages/core", "packages/cli", "packages/extensions/herdr"];
const corePackageName = "@marcoscale98/pi-extensible-workflows";
const cliPackageName = "@marcoscale98/piewf-cli";
const herdrPackageName = "@marcoscale98/piewf-herdr";

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function packagePath(base, name) { return resolve(base, "node_modules", ...name.split("/")); }
function tarballName({ name, version }) { return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`; }
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const target = resolve(path, entry.name);
    return entry.isDirectory() ? files(target) : [target];
  });
}
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function filePathHasTestDirectory(path) { return path.split(/[\\/]/).includes("test"); }
function relativeImports(source) {
  const imports = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if ((value.type === "ImportDeclaration" || value.type === "ExportNamedDeclaration" || value.type === "ExportAllDeclaration") && typeof value.source?.value === "string") imports.push(value.source.value);
    if (value.type === "ImportExpression" && typeof value.source?.value === "string") imports.push(value.source.value);
    for (const child of Object.values(value)) {
      if (!child || typeof child !== "object") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return imports.filter((specifier) => specifier.startsWith("."));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a Trajectory port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function trajectorySmoke(coreRoot, lockPath) {
  const port = await availablePort();
  const child = spawn(process.execPath, [resolve(coreRoot, "dist/trajectory/src/server.js"), "--port", String(port), "--lock", lockPath, "--fingerprint", "packed-smoke"], { stdio: ["ignore", "ignore", "pipe"] });
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${String(port)}/`, { signal: globalThis.AbortSignal.timeout(500) });
        if (response.ok) {
          const html = await response.text();
          if (!html.includes("<title>Trajectory</title>")) throw new Error("Packed Trajectory returned an unexpected document");
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Packed Trajectory")) throw error;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    throw new Error("Packed Trajectory server did not become healthy");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    child.stderr?.destroy();
  }
}

try {
  mkdirSync(output, { recursive: true });
  const packages = workspaces.map((workspace) => ({ workspace, manifest: json(resolve(root, workspace, "package.json")) }));
  for (const { workspace } of packages) execFileSync("npm", ["pack", `--workspace=${workspace}`, "--pack-destination", output], { cwd: root, stdio: "pipe", timeout: 120_000 });

  const errors = [];
  for (const { manifest } of packages) {
    const tarball = resolve(output, tarballName(manifest));
    const extracted = resolve(work, "extracted", manifest.name.replaceAll("/", "-"));
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", extracted, "--strip-components=1"], { stdio: "pipe", timeout: 30_000 });
    const packed = json(resolve(extracted, "package.json"));
    const packedFiles = files(extracted);
    if (manifest.name === corePackageName) {
      for (const required of ["dist/trajectory/src/server.js", "dist/trajectory/src/assets/index.html", "dist/trajectory/assets/index.html", "starter/prompts/review-loop.md"]) {
        if (!existsSync(resolve(extracted, required))) errors.push(`${manifest.name}: missing compiled package artifact ${required}`);
      }
    }
    const entrypoints = [packed.main, ...strings(packed.bin), ...strings(packed.exports), ...strings(packed.pi?.extensions)].filter((path) => typeof path === "string" && path.startsWith("./"));
    for (const entrypoint of entrypoints) if (!existsSync(resolve(extracted, entrypoint))) errors.push(`${manifest.name}: missing entrypoint ${entrypoint}`);
    for (const file of packedFiles.filter((path) => path.startsWith(resolve(extracted, "dist")) && (filePathHasTestDirectory(path.slice(extracted.length + 1)) || path.includes(".test.")))) errors.push(`${manifest.name}: published test artifact ${file.slice(extracted.length + 1)}`);
    for (const file of packedFiles.filter((path) => path.endsWith(".js"))) {
      for (const specifier of relativeImports(readFileSync(file, "utf8"))) if (!existsSync(resolve(dirname(file), specifier))) errors.push(`${manifest.name}: ${file.slice(extracted.length + 1)} imports missing ${specifier}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const tarballs = packages.map(({ manifest }) => resolve(output, tarballName(manifest)));
  execFileSync("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", ...tarballs], { stdio: "pipe", timeout: 120_000 });
  const cli = spawnSync(resolve(installRoot, "node_modules", ".bin", "piewf"), ["run", "--help"], { cwd: work, encoding: "utf8" });
  const cliOutput = `${cli.stdout ?? ""}${cli.stderr ?? ""}`;
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cliOutput.includes("Usage: piewf run")) throw new Error(`Standalone CLI smoke test failed (${String(cli.status)}):\n${cliOutput}`);
  execFileSync("npm", ["audit", "--prefix", installRoot, "--omit=dev"], { stdio: "pipe", timeout: 60_000 });

  const installedCore = packagePath(installRoot, corePackageName);
  const installedCli = packagePath(installRoot, cliPackageName);
  const installedHerdr = packagePath(installRoot, herdrPackageName);
  if (!existsSync(resolve(installedCli, "package.json"))) throw new Error("Scoped CLI tarball was not installed");
  if (!existsSync(resolve(installedHerdr, "package.json"))) throw new Error("Scoped Herdr tarball was not installed");
  if (existsSync(packagePath(installRoot, "pi-extensible-workflows"))) throw new Error("The installed package tree contains the upstream core package");
  const cliManifest = json(resolve(installedCli, "package.json"));
  if (cliManifest.dependencies?.[corePackageName] === undefined || cliManifest.dependencies?.["pi-extensible-workflows"] !== undefined) throw new Error("Scoped CLI does not depend on the scoped fork core");
  const herdrManifest = json(resolve(installedHerdr, "package.json"));
  if (herdrManifest.peerDependencies?.[corePackageName] === undefined || herdrManifest.peerDependencies?.["pi-extensible-workflows"] !== undefined) throw new Error("Scoped Herdr does not peer-depend on the scoped fork core");
  await trajectorySmoke(installedCore, resolve(work, "trajectory.lock"));
  const localPackages = [installedCore, installedHerdr];
  const extensionCount = localPackages.reduce((count, directory) => count + strings(json(resolve(directory, "package.json")).pi?.extensions).length, 0);
  const pi = resolve(root, "node_modules/.bin/pi");
  const herdrVariables = new Set(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !herdrVariables.has(name))), PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1" };
  for (const directory of localPackages) {
    const installation = spawnSync(pi, ["install", directory], { cwd: work, encoding: "utf8", env, timeout: 30_000 });
    if (installation.error) throw installation.error;
    if (installation.status !== 0) throw new Error(`Pi local package installation failed (${String(installation.status)}):\n${installation.stdout ?? ""}${installation.stderr ?? ""}`);
  }
  const result = spawnSync(pi, ["--mode", "rpc"], { cwd: work, encoding: "utf8", env, input: "", timeout: 30_000 });
  const outputText = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0 || /Failed to load extension|Cannot find module/.test(outputText)) throw new Error(`Pi package discovery smoke test failed (${String(result.status)}):\n${outputText}`);

  process.stdout.write(`Package verification passed: ${packages.length} tarballs, ${localPackages.length} local Pi packages, and ${extensionCount} discovered extensions.\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
