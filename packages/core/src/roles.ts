import { collectRoleContributions } from "@piewf/pi-ext-roles";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as roles from "@piewf/pi-ext-roles/roles";
import type { RoleDirectoryRegistration } from "@piewf/pi-ext-roles/types";
import type { AgentDefinition, WorkflowExtensionSettings } from "./types.js";
import { resolveWorkflowSettings, validateWorkflowExtensionSettings, workflowSettingsPath } from "./settings.js";
import { errorText, mergeWorkflowExtensionSettings, roleApi } from "./utils.js";

export function activeRoleDirectories(bus: { emit?: EventBus["emit"]; on?: EventBus["on"] } | undefined): readonly RoleDirectoryRegistration[] {
  const emit = bus?.on ? bus.emit?.bind(bus) : undefined;
  return emit ? roleApi(() => collectRoleContributions({ emit }, { activeOnly: true })) : [];
}

export type WorkflowRoleDirectoryInput = string | RoleDirectoryRegistration;
export type RoleDiscoveryOptions = roles.RoleDiscoveryOptions;
export type RoleResourceCandidates = roles.RoleResourceCandidates;
export type RoleResolutionOptions = Omit<roles.RoleResolutionOptions, "definition" | "definitions" | "extensionSettings"> & { definition?: AgentDefinition; definitions?: Readonly<Record<string, AgentDefinition>>; extensionSettings?: Readonly<WorkflowExtensionSettings>; useSharedSettings?: boolean };
export type ResolvedRole = Omit<roles.ResolvedRole, "definition" | "extensionSettings"> & { definition?: AgentDefinition; extensionSettings?: Readonly<WorkflowExtensionSettings> };
export { canonicalExtensionSelector } from "@piewf/pi-ext-roles/roles";

export function workflowRoleDirectories(agentDir = getAgentDir()): readonly string[] {
  return [join(agentDir, "pi-extensible-workflows", "roles")];
}
export function legacyRoleSources(cwd: string, agentDir = getAgentDir()): readonly RoleDirectoryRegistration[] {
  return [
    { path: join(agentDir, "pi-extensible-workflows", "roles"), scope: "global", priority: 0 },
    { path: join(cwd, ".pi", "pi-extensible-workflows", "roles"), scope: "project", priority: 0 },
  ];
}
function discoveryInput(input: RoleDiscoveryOptions): RoleDiscoveryOptions {
  return { ...input, additionalRoleSources: [...legacyRoleSources(input.cwd, input.agentDir), ...(input.additionalRoleSources ?? [])] };
}
function validateDefinition(definition: NonNullable<roles.ResolvedRole["definition"]>, path = "<role>"): AgentDefinition {
  validateWorkflowExtensionSettings(definition.extensionSettings, definition.provenance?.path ?? path, "INVALID_METADATA");
  return definition;
}
export function parseRoleMarkdown(content: string, strict = false, rolePath?: string): AgentDefinition {
  return validateDefinition(roleApi(() => roles.parseRoleMarkdown(content, strict, rolePath)), rolePath);
}
export function discoverRoles(input: RoleDiscoveryOptions): Readonly<Record<string, AgentDefinition>> {
  const definitions = roleApi(() => roles.discoverRoles(discoveryInput(input)));
  for (const definition of Object.values(definitions)) validateDefinition(definition);
  return definitions;
}
export function loadRole(name: string, input: RoleDiscoveryOptions): AgentDefinition {
  return validateDefinition(roleApi(() => roles.loadRole(name, discoveryInput(input))));
}
export function loadAgentDefinitions(cwd: string, agentDir = getAgentDir(), projectTrusted = true, extensionRoleDirectories?: readonly WorkflowRoleDirectoryInput[]): Readonly<Record<string, AgentDefinition>> {
  return discoverRoles({ cwd, agentDir, projectTrusted, ...(extensionRoleDirectories === undefined ? {} : { extensionRoleDirectories }) });
}
export function loadProjectAgentDefinitions(cwd: string): Readonly<Record<string, AgentDefinition>> {
  const definitions = roleApi(() => roles.loadProjectAgentDefinitions(cwd, legacyRoleSources(cwd).filter(source => source.scope === "project")));
  for (const definition of Object.values(definitions)) validateDefinition(definition);
  return definitions;
}
export function resolveRole(name: string | undefined, options: RoleResolutionOptions): ResolvedRole {
  const settings = options.useSharedSettings !== false ? resolveWorkflowSettings(options.cwd, options.projectTrusted ?? true, options.settingsPath ?? workflowSettingsPath(options.agentDir)) : undefined;
  const input = { ...options };
  delete input.settingsPath;
  const definition = name === undefined ? undefined : options.definition ?? options.definitions?.[name] ?? loadRole(name, discoveryInput(input));
  const extensionSettings = mergeWorkflowExtensionSettings(settings?.effective.extensionSettings, definition?.extensionSettings, options.extensionSettings);
  const result = roleApi(() => {
    try {
      return roles.resolveRole(name, {
        ...input, ...discoveryInput(input), ...{ useSharedSettings: false },
        ...(definition === undefined ? {} : { definition }),
        modelAliases: { ...settings?.effective.modelAliases, ...options.modelAliases },
        selectorSources: options.selectorSources === undefined ? settings?.selectorSources ?? { global: {}, project: {} } : settings?.selectorSources.defaults === undefined ? options.selectorSources : { ...options.selectorSources, defaults: settings.selectorSources.defaults },
        ...(extensionSettings === undefined ? {} : { extensionSettings }),
      });
    }
    catch (error) {
      if (options.settingsPath && error instanceof Error && !errorText(error).includes("(settings:")) error.message += ` (settings: ${options.settingsPath})`;
      throw error;
    }
  });
  if (result.definition) validateDefinition(result.definition);
  validateWorkflowExtensionSettings(result.extensionSettings, options.settingsPath ?? "<role>");
  return result;
}
