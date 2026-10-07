import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { object } from "./utils.js";

const fields = ["modelAliases", "tools", "skills", "extensions"];
export function deprecatedRoleSources(cwd: string, agentDir: string, projectTrusted: boolean): readonly string[] {
  const roots = [join(agentDir, "pi-extensible-workflows"), ...(projectTrusted ? [join(cwd, ".pi", "pi-extensible-workflows")] : [])];
  const sources: string[] = [];
  for (const root of roots) {
    const roles = join(root, "roles");
    if (existsSync(roles)) {
      for (const name of readdirSync(roles).sort()) {
        const path = join(roles, name);
        if (name.endsWith(".md") && statSync(path).isFile()) sources.push(path);
      }
    }
    const settings = join(root, "settings.json");
    if (!existsSync(settings)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(settings, "utf8"));
      if (object(value)) for (const field of fields) if (Object.hasOwn(value, field)) sources.push(`${settings}: ${field}`);
    } catch { /* Invalid settings are diagnosed by the settings consumer. */ }
  }
  return sources;
}

const noticeKey = Symbol.for("pi-extensible-workflows.role-deprecation-notices");
export function notifyRoleDeprecation(context: {
  mode?: string;
  cwd: string;
  isProjectTrusted?: () => boolean;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, type: "warning"): void };
}, agentDir = getAgentDir()): void {
  if (context.mode !== "tui") return;
  let notices = Reflect.get(globalThis, noticeKey) as WeakMap<object, Set<string>> | undefined;
  if (!notices) { notices = new WeakMap(); Reflect.set(globalThis, noticeKey, notices); }
  const manager = context.sessionManager;
  const id = manager.getSessionId();
  const seen = notices.get(manager) ?? new Set<string>();
  if (seen.has(id)) return;
  seen.add(id);
  notices.set(manager, seen);
  let sources: readonly string[];
  try { sources = deprecatedRoleSources(context.cwd, agentDir, context.isProjectTrusted?.() === true); }
  catch { return; }
  if (sources.length) context.ui.notify(`Legacy role sources:\n${sources.join("\n")}\nMove role files and shared role settings to pi-ext-roles/roles and pi-ext-roles/settings.json. Workflow settings remain consumer overrides; no files are changed automatically.`, "warning");
}
