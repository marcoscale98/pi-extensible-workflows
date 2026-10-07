export { runPiRole, LAUNCHER_USAGE } from "@piewf/pi-ext-roles/launcher";
import { resolve } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { DefaultPackageManager, DefaultResourceLoader, ModelRuntime, ProjectTrustStore, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadRole, type ResolvedRole } from "pi-extensible-workflows/roles";
import { resolveRole } from "@piewf/pi-ext-roles/roles";
import { CONTEXT_FILE_SCOPES } from "@piewf/pi-ext-roles/types";

// Legacy projection enumerates builtin tools only, without executing extension factories.
const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function projectTrust(cwd: string, agentDir: string, args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const flag = args.slice(0, end < 0 ? args.length : end).filter((arg) => ["--approve", "-a", "--no-approve", "-na"].includes(arg)).at(-1); // last wins, as in pi
  if (flag) return flag === "--approve" || flag === "-a";
  return new ProjectTrustStore(agentDir).get(cwd) ?? false; // no saved decision: project roles, settings, and resources stay out
}

/** @deprecated Legacy argv projection only; use runPiRole for native CLI startup. */
export function piArguments(role: ResolvedRole, skillPaths: ReadonlyMap<string, string>, rest: readonly string[]): string[] {
  if (role.extensionSettings !== undefined) throw new Error("Legacy pi-role argument projection does not support extensionSettings; use the programmatic role API (the native CLI also ignores these settings)");
  const argv: string[] = [];
  if (role.model) argv.push("--model", `${role.model.provider}/${role.model.model}${role.model.thinking ? `:${role.model.thinking}` : ""}`);
  if (role.selectorLayers.tools.some((layer) => layer !== undefined)) argv.push("--tools", (role.tools ?? []).join(","));
  argv.push("--no-skills");
  for (const name of role.selectedSkills ?? []) argv.push("--skill", skillPaths.get(name) ?? name);
  argv.push("--no-extensions");
  for (const path of role.selectedExtensions ?? []) argv.push("--extension", path);
  if (role.systemPrompt.text) argv.push(role.systemPrompt.mode === "override" ? "--system-prompt" : "--append-system-prompt", role.systemPrompt.text);
  if (role.contextFiles !== undefined && new Set(role.contextFiles).size < CONTEXT_FILE_SCOPES.length) {
    if (role.contextFiles.length > 0) throw new Error(`Role ${role.name ?? ""} selects a subset of context file scopes (${role.contextFiles.join(", ")}); pi-role only supports all scopes or none`);
    argv.push("--no-context-files");
  }
  return [...argv, ...rest];
}

/** @deprecated Enumeration-only legacy projection; does not apply contributor SDK startup state. */
export async function resolvePiArguments(name: string, rest: readonly string[], cwd = process.cwd(), agentDir = getAgentDir()): Promise<string[]> {
  const projectTrusted = projectTrust(cwd, agentDir, rest);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  settingsManager.setProjectTrusted(projectTrusted);
  const discovered = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve();
  const visible = ({ enabled, metadata }: { enabled: boolean; metadata: { scope: string } }) => enabled && (projectTrusted || metadata.scope !== "project");
  const extensions = [...new Set(discovered.extensions.filter(visible).map(({ path }) => path))];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, additionalSkillPaths: [...new Set(discovered.skills.filter(visible).map(({ path }) => path))] });
  await loader.reload();
  const skillPaths = new Map(loader.getSkills().skills.map(({ name: skill, filePath }) => [skill, filePath]));
  const discovery = { cwd, agentDir, projectTrusted, extensionRoleDirectories: [] };
  const runtime = await ModelRuntime.create({ authPath: resolve(agentDir, "auth.json"), modelsPath: resolve(agentDir, "models.json"), modelsStore: new InMemoryModelsStore() });
  const role = resolveRole(name, { ...discovery, definition: loadRole(name, discovery),
    knownModels: new Set(runtime.getModels().map(({ provider, id }) => `${provider}/${id}`)),
    availableModels: new Set((await runtime.getAvailable()).map(({ provider, id }) => `${provider}/${id}`)),
    resources: { extensions, skills: [...skillPaths.keys()], tools: PI_BUILTIN_TOOLS },
  });
  const unsupportedTools = role.unmatchedTools?.filter(selector => !selector.startsWith("!"));
  if (unsupportedTools?.length) throw new Error(`Legacy pi-role argument projection cannot enumerate extension tools: ${unsupportedTools.join(", ")}; use runPiRole`);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- This isolated helper owns the legacy projection.
  return piArguments(role, skillPaths, rest);
}
