import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(resolve(tmpdir(), "piewf-packages-"));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(work, "tarballs");
const agentRoot = resolve(work, "packed", "consumer", "agent");
const installRoot = resolve(agentRoot, "npm");
const workspaces = ["packages/core", "packages/cli", "packages/extensions/herdr"];

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

try {
  mkdirSync(output, { recursive: true });
  const rolesManifest = json(resolve(packagePath(root, "@piewf/pi-ext-roles"), "package.json"));
  const rolesSpec = `${rolesManifest.name}@${rolesManifest.version}`;
  execFileSync("npm", ["pack", rolesSpec, "--ignore-scripts", "--pack-destination", output], { cwd: root, stdio: "pipe", timeout: 120_000 });
  const packages = workspaces.map((workspace) => ({ workspace, manifest: json(resolve(root, workspace, "package.json")) }));
  for (const { workspace } of packages) execFileSync("npm", ["pack", `--workspace=${workspace}`, "--pack-destination", output], { cwd: root, stdio: "pipe", timeout: 120_000 });

  const errors = [];
  for (const { manifest } of [...packages, { manifest: rolesManifest }]) {
    const tarball = resolve(output, tarballName(manifest));
    const extracted = resolve(work, "extracted", manifest.name.replaceAll("/", "-"));
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", extracted, "--strip-components=1"], { stdio: "pipe", timeout: 30_000 });
    const packed = json(resolve(extracted, "package.json"));
    if (["pi-extensible-workflows", "@piewf/cli"].includes(manifest.name) && packed.dependencies?.[rolesManifest.name] !== rolesManifest.version) errors.push(`${manifest.name}: roles dependency must be the verified registry version ${rolesManifest.version}`);
    const packedFiles = files(extracted);
    if (manifest.name === "@piewf/pi-ext-roles") {
      if (packed.exports?.["./pi"]) errors.push(`${manifest.name}: removed SDK export ./pi`);
      for (const artifact of packedFiles.filter(path => path.startsWith(resolve(extracted, "dist/pi.")))) errors.push(`${manifest.name}: stale SDK artifact ${artifact.slice(extracted.length + 1)}`);
      for (const bridge of ["src/cli-tool-bridge.ts", "dist/cli-tool-bridge.js"]) if (!existsSync(resolve(extracted, bridge))) errors.push(`${manifest.name}: missing native bridge ${bridge}`);
      if (packed.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "*" || packed.dependencies?.["@earendil-works/pi-coding-agent"]) errors.push(`${manifest.name}: native host must remain a wildcard peer`);
      if (packed.bin?.["pi-role"] !== "./dist/cli.js") errors.push(`${manifest.name}: standalone CLI must own pi-role`);
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
  const roleBinary = resolve(installRoot, "node_modules", ".bin", "pi-role");
  if (!readlinkSync(roleBinary).includes("pi-ext-roles/dist/cli.js")) throw new Error("pi-role binary is not owned by the independent package");
  if (json(resolve(packagePath(installRoot, "@piewf/cli"), "package.json")).bin["pi-role"]) throw new Error("CLI still owns pi-role");
  const smokeEnv = { ...process.env, HOME: work, XDG_CACHE_HOME: resolve(work, "cache"), PI_CODING_AGENT_DIR: resolve(work, "isolated-agent"), PI_OFFLINE: "1", PATH: `${resolve(installRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}` };
  const piRole = spawnSync(roleBinary, ["--list", "--no-extensions"], { cwd: work, encoding: "utf8", env: smokeEnv, timeout: 30_000 });
  const piRoleOutput = `${piRole.stdout ?? ""}${piRole.stderr ?? ""}`;
  if (piRole.error) throw piRole.error;
  if (piRole.status !== 0 || !piRoleOutput.includes("developer") || /default model|developer-model/.test(piRoleOutput)) throw new Error(`pi-role list smoke failed:\n${piRoleOutput}`);
  const importSmoke = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { runPiRole, piArguments, resolvePiArguments } from '@piewf/cli/pi-role';
    import { runPiRole as independent } from '@piewf/pi-ext-roles/launcher';
    import * as independentRoles from '@piewf/pi-ext-roles';
    import { resolveRole as resolveIndependent, discoverRoles } from '@piewf/pi-ext-roles/roles';
    import { composeRoleConfiguration } from '@piewf/pi-ext-roles/settings';
    for (const name of ['prepareRoleApplication', 'createRoleRuntime', 'getRoleExtensionSettings']) assert.equal(name in independentRoles, false);
    await assert.rejects(import('@piewf/pi-ext-roles/pi'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    const configuration = composeRoleConfiguration({ cwd: process.cwd(), projectTrusted: false, modelAliases: { selected: 'fixture/model' }, selectorSources: { global: { tools: ['read'] }, project: {} } });
    assert.deepEqual(configuration.modelAliases, { selected: 'fixture/model' });
    assert.deepEqual(configuration.selectorSources.global.tools, ['read']);
    const definitions = discoverRoles({ cwd: process.cwd(), projectTrusted: false, extensionRoleDirectories: [] });
    const options = resolveIndependent('scout', { cwd: process.cwd(), projectTrusted: false, definitions, rootTools: ['read', 'write'] });
    assert.deepEqual(options.tools, ['read']);
    assert.equal(options.systemPrompt.mode, 'append');
    assert.ok(options.prompt.length > 0);
    assert.equal(options.definition, definitions.scout);
    import * as root from 'pi-extensible-workflows';
    import * as roles from 'pi-extensible-workflows/roles';
    import * as types from 'pi-extensible-workflows/types';
    import * as validation from 'pi-extensible-workflows/validation';
    import * as utils from 'pi-extensible-workflows/utils';
    assert.equal(runPiRole, independent);
    assert.equal(typeof piArguments, 'function');
    assert.equal(typeof resolvePiArguments, 'function');
    for (const api of [root, roles]) for (const name of ['parseRoleMarkdown', 'discoverRoles', 'resolveRole']) assert.equal(typeof api[name], 'function');
    assert.equal(typeof types.WorkflowError, 'function');
    assert.equal(typeof validation.validateWorkflowLaunch, 'function');
    assert.equal(typeof utils.resolveModelReference, 'function');
    assert.equal(typeof root.registerWorkflowExtension, 'function');
    for (const name of ['registeredWorkflowRoleDirectories', 'registeredWorkflowRoleDirectoryRegistrations', 'bridgeWorkflowRoleContributions']) assert.equal(name in root, false);
    assert.throws(() => root.registerWorkflowExtension({ version: '1.0.0', headline: 'Legacy bundle', roleDirectories: [] }), error => error.code === 'INVALID_METADATA' && error.message.includes('registerRoleContribution'));
  `], { cwd: installRoot, encoding: "utf8", env: smokeEnv, timeout: 30_000 });
  if (importSmoke.error) throw importSmoke.error;
  if (importSmoke.status !== 0) throw new Error(`Compatibility imports failed:\n${importSmoke.stderr}`);
  const launch = spawnSync(roleBinary, ["developer", "--model", "missing/phase8-invalid", "-p", "--no-session"], { cwd: work, encoding: "utf8", env: smokeEnv, timeout: 30_000 });
  if (launch.error) throw launch.error;
  if (launch.status !== 1 || !/Unknown model|unavailable|not found/i.test(launch.stderr ?? "") || /starting pi with its default model/.test(launch.stderr ?? "")) throw new Error(`Invalid explicit model smoke failed:\n${launch.stdout ?? ""}${launch.stderr ?? ""}`);
  const help = spawnSync(roleBinary, ["--help"], { cwd: work, encoding: "utf8", env: smokeEnv, timeout: 30_000 });
  if (help.error) throw help.error;
  if (help.status !== 0 || !help.stdout.includes("Usage: pi-role") || !help.stdout.includes("--session")) throw new Error(`Native help smoke failed:\n${help.stdout ?? ""}${help.stderr ?? ""}`);
  mkdirSync(resolve(smokeEnv.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
  writeFileSync(resolve(smokeEnv.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ cacheWarming: "off", defaultProjectTrust: "never" }));
  writeFileSync(resolve(smokeEnv.PI_CODING_AGENT_DIR, "extensions/fixture.js"), `export default pi => pi.registerProvider('fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] });`);
  const sessionFile = resolve(work, "native-session.jsonl");
  const session = spawnSync(roleBinary, ["developer", "--model", "fixture/model:medium", "--mode", "rpc", "--session", sessionFile], { cwd: work, encoding: "utf8", env: smokeEnv, input: '{"id":"state","type":"get_state"}\n', timeout: 30_000 });
  if (session.error) throw session.error;
  const state = session.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(response => response.id === "state");
  if (session.status !== 0 || state?.success !== true || state.data?.sessionFile !== sessionFile || state.data?.model?.provider !== "fixture") throw new Error(`Native session smoke failed:\n${session.stdout ?? ""}${session.stderr ?? ""}`);
  // Real isolated model/tool and upgrade checks run in scripts/verify-role-upgrade.py.
  const aloneRoot = resolve(work, "standalone", "consumer", "npm");
  execFileSync("npm", ["install", "--prefix", aloneRoot, "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "@earendil-works/pi-coding-agent@1.0.0", rolesSpec], { stdio: "pipe", timeout: 120_000 });
  if (existsSync(packagePath(aloneRoot, "pi-extensible-workflows")) || existsSync(packagePath(aloneRoot, "@piewf/cli"))) throw new Error("Independent component installed workflow dependencies");
  const alone = spawnSync(resolve(aloneRoot, "node_modules", ".bin", "pi-role"), ["--list", "--no-extensions"], { cwd: work, encoding: "utf8", env: { ...smokeEnv, PATH: `${resolve(aloneRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}` }, timeout: 30_000 });
  if (alone.error) throw alone.error;
  if (alone.status !== 0 || !alone.stdout.includes("scout")) throw new Error(`Independent component alone failed:\n${alone.stdout ?? ""}${alone.stderr ?? ""}`);
  // ponytail: npm audit has no per-advisory ignore. These brace-expansion advisories come from the
  // npm-shrinkwrap.json of @earendil-works/pi-coding-agent@1.0.0, which pins 5.0.9 (fixed in 5.0.12)
  // and cannot be overridden by a dependent. Drop them once Pi ships an updated shrinkwrap.
  const ignoredAdvisories = new Set(["https://github.com/advisories/GHSA-q2hr-2g5m-vwhr", "https://github.com/advisories/GHSA-qhr7-859c-m2p7", "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p"]);
  const audit = spawnSync("npm", ["audit", "--prefix", installRoot, "--omit=dev", "--json"], { encoding: "utf8", timeout: 60_000 });
  if (audit.error) throw audit.error;
  const report = JSON.parse(audit.stdout);
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  // Every vulnerable package traces back to an advisory object in some `via` list; string entries name other vulnerable packages.
  const advisories = Object.values(report.vulnerabilities ?? {}).flatMap(({ via }) => via.filter((entry) => typeof entry === "object"));
  const reported = advisories.filter(({ url }) => !ignoredAdvisories.has(url));
  if (reported.length) throw new Error(`npm audit found vulnerabilities:\n${[...new Set(reported.map(({ name, severity, url }) => `${name} (${severity}): ${url}`))].join("\n")}`);

  const localPackages = ["pi-extensible-workflows", "@piewf/herdr"].map((name) => packagePath(installRoot, name));
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

  process.stdout.write(`Package verification passed: ${packages.length + 1} tarballs, ${localPackages.length} local Pi packages, and ${extensionCount} discovered extensions.\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
