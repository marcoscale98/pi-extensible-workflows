import { atomicWriteFile } from "./persistence.js";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, type ToolAnnotations } from "@earendil-works/pi-coding-agent";
import type { AgentResourcePolicy, AgentResourceSelectorSources, AgentResourceSelectors, AgentResourceSelectorSet, ContextFileScope, JsonValue, WorkflowExtensionSettings, WorkflowRetentionSettings, WorkflowSettings, WorkflowSettingsOverrides, WorkflowSettingsResolution, WorkflowSettingsSources } from "./types.js";
import * as roleSettings from "@piewf/pi-ext-roles/settings";
import { annotateModelAliasError, deepFreeze, errorText, fail, isNodeError, modelCapability, object, positiveInteger, unknownModel, validateModelAliases } from "./utils.js";
import { mergeWorkflowExtensionSettings, roleApi } from "./utils.js";

const ROLE_DIRECTORY = "pi-extensible-workflows";
export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8, backgroundWidget: true });
export function workflowSettingsPath(agentDir = getAgentDir()): string { return join(agentDir, ROLE_DIRECTORY, "settings.json"); }
export function workflowProjectSettingsPath(cwd: string): string { return join(cwd, ".pi", ROLE_DIRECTORY, "settings.json"); }
export function validateSelectorList(...args: Parameters<typeof roleSettings.validateSelectorList>): readonly string[] | undefined { return roleApi(() => roleSettings.validateSelectorList(...args)); }
function selectorsFromSettings(settings: Readonly<WorkflowSettings | WorkflowSettingsOverrides>): AgentResourceSelectors {
  return {
    ...(settings.skills === undefined ? {} : { skills: settings.skills }),
    ...(settings.extensions === undefined ? {} : { extensions: settings.extensions }),
    ...(settings.tools === undefined ? {} : { tools: settings.tools }),
  };
}
function selectorSet(value: AgentResourceSelectors | undefined): AgentResourceSelectorSet { return { skills: [...(value?.skills ?? [])], extensions: [...(value?.extensions ?? [])], ...(value?.tools === undefined ? {} : { tools: [...value.tools] }) }; }
export function validateContextFileScopes(value: unknown, rolePath: string): readonly ContextFileScope[] | undefined { return roleApi(() => roleSettings.validateContextFileScopes(value, rolePath)); }
export function validateWorkflowExtensionSettings(value: unknown, settingsPath: string, errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS"): WorkflowExtensionSettings | undefined {
  const generic = roleApi(() => roleSettings.validateExtensionSettings(value, settingsPath, errorCode));
  if (generic === undefined) return undefined;
  const base = `${settingsPath}.extensionSettings`;
  const normalized: Record<string, JsonValue> = {};
  for (const [namespace, raw] of Object.entries(generic)) {
    if (namespace === "herdr") {
      if (!object(raw)) fail(errorCode, `${base}.herdr must be an object`);
      if (Object.keys(raw).some((key) => key !== "enableFullyInspectableMode")) fail(errorCode, `${base}.herdr contains an unsupported setting`);
      if (raw.enableFullyInspectableMode !== undefined && typeof raw.enableFullyInspectableMode !== "boolean") fail(errorCode, `${base}.herdr.enableFullyInspectableMode must be a boolean`);
      normalized.herdr = Object.freeze({ ...(raw.enableFullyInspectableMode === undefined ? {} : { enableFullyInspectableMode: raw.enableFullyInspectableMode }) });
      continue;
    }
    if (namespace === "trajectory") {
      if (!object(raw)) fail(errorCode, `${base}.trajectory must be an object`);
      if (Object.keys(raw).some((key) => key !== "port")) fail(errorCode, `${base}.trajectory contains an unsupported setting`);
      if (raw.port !== undefined && (!positiveInteger(raw.port) || raw.port > 65535)) fail(errorCode, `${base}.trajectory.port must be an integer from 1 to 65535`);
      normalized.trajectory = Object.freeze({ ...(raw.port === undefined ? {} : { port: raw.port }) });
      continue;
    }
    normalized[namespace] = structuredClone(raw);
  }
  return deepFreeze(normalized as WorkflowExtensionSettings);
}
function positiveRetentionInteger(value: unknown): value is number { return positiveInteger(value) && Number.isSafeInteger(value); }
function validateRetention(value: unknown, settingsPath: string): Readonly<WorkflowRetentionSettings> | undefined {
  if (value === undefined) return undefined;
  const base = `${settingsPath}.retention`;
  if (!object(value)) fail("INVALID_SETTINGS", `${base} must be an object`);
  const unknown = Object.keys(value).find((key) => key !== "olderThanDays" && key !== "maxTerminalRuns");
  if (unknown) fail("INVALID_SETTINGS", `Unknown retention setting at ${base}: ${unknown}`);
  if (value.olderThanDays !== undefined && !positiveRetentionInteger(value.olderThanDays)) fail("INVALID_SETTINGS", `${base}.olderThanDays must be a positive integer`);
  if (value.maxTerminalRuns !== undefined && !positiveRetentionInteger(value.maxTerminalRuns)) fail("INVALID_SETTINGS", `${base}.maxTerminalRuns must be a positive integer`);
  return Object.freeze({ ...(value.olderThanDays === undefined ? {} : { olderThanDays: value.olderThanDays }), ...(value.maxTerminalRuns === undefined ? {} : { maxTerminalRuns: value.maxTerminalRuns }) });
}
function parseSettings(path: string, partial: false): Readonly<WorkflowSettings>;
function parseSettings(path: string, partial: true): Readonly<WorkflowSettingsOverrides>;
function parseSettings(path: string, partial: boolean): Readonly<WorkflowSettings | WorkflowSettingsOverrides> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (isNodeError(error, "ENOENT")) return partial ? Object.freeze({}) : DEFAULT_SETTINGS;
    fail("CONFIG_ERROR", `Invalid workflow settings JSON at ${path}: ${errorText(error)}`);
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", `Workflow settings at ${path} must be an object`);
  const allowed = new Set(["concurrency", "modelAliases", "skills", "extensions", "extensionSettings", "tools", "retention", ...(partial ? [] : ["backgroundWidget", "codemodeTools"]) ]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (Object.prototype.hasOwnProperty.call(parsed, "disabledAgentResources")) fail("INVALID_SETTINGS", `disabledAgentResources is no longer supported; use skills, extensions, and tools selectors (settings: ${path})`);
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting at ${path}: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? (partial ? undefined : DEFAULT_SETTINGS.concurrency) : parsed.concurrency;
  if (concurrency !== undefined && (!positiveInteger(concurrency) || concurrency > 16)) fail("INVALID_SETTINGS", `${path}.concurrency must be an integer from 1 to 16`);
  const backgroundWidget = parsed.backgroundWidget === undefined ? (partial ? undefined : DEFAULT_SETTINGS.backgroundWidget) : parsed.backgroundWidget;
  if (backgroundWidget !== undefined && typeof backgroundWidget !== "boolean") fail("INVALID_SETTINGS", `${path}.backgroundWidget must be a boolean`);
  const codemodeTools = parsed.codemodeTools;
  if (codemodeTools !== undefined && codemodeTools !== "all" && codemodeTools !== "read-only" && codemodeTools !== "none") fail("INVALID_SETTINGS", `${path}.codemodeTools must be "all", "read-only", or "none"`);
  const modelAliases = parsed.modelAliases === undefined ? undefined : validateModelAliases(parsed.modelAliases, path);
  const skills = validateSelectorList(parsed.skills, path, "skills");
  const tools = validateSelectorList(parsed.tools, path, "tools");
  const extensions = validateSelectorList(parsed.extensions, path, "extensions");
  const extensionSettings = parsed.extensionSettings === undefined ? undefined : validateWorkflowExtensionSettings(parsed.extensionSettings, path, "INVALID_SETTINGS");
  const retention = validateRetention(parsed.retention, path);
  return Object.freeze({
    ...(concurrency === undefined ? {} : { concurrency }), ...(backgroundWidget === undefined ? {} : { backgroundWidget }), ...(codemodeTools === undefined ? {} : { codemodeTools }), ...(modelAliases === undefined ? {} : { modelAliases }),
    ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }),
    ...(extensionSettings === undefined ? {} : { extensionSettings }), ...(tools === undefined ? {} : { tools }), ...(retention === undefined ? {} : { retention }),
  });
}
export function loadSettings(path = workflowSettingsPath()): Readonly<WorkflowSettings> { return parseSettings(path, false); }
const READ_ONLY_WORKFLOW_TOOLS: ReadonlySet<string> = new Set(["workflow_status", "workflow_catalog", "subagents_inspect"]);
/**
 * Exposure and annotations of a workflow or subagent tool. Under the global `codemodeTools` setting,
 * `model-only` keeps the model's direct access and stops codemode scripts from calling the tool.
 * Tools are registered once at load, so the setting is global and applies after a reload.
 * Read-only tools carry `readOnlyHint` so permission extensions need not confirm them.
 */
export function workflowToolExposure(name: string, codemodeTools: WorkflowSettings["codemodeTools"]): { exposure?: "model-only"; annotations?: ToolAnnotations } {
  const readOnly = READ_ONLY_WORKFLOW_TOOLS.has(name);
  return { ...(codemodeTools === "none" || (codemodeTools === "read-only" && !readOnly) ? { exposure: "model-only" as const } : {}), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) };
}
/** The `codemodeTools` setting at load time. Invalid settings keep the default; launches report them. */
export function loadCodemodeToolsSetting(agentDir?: string): WorkflowSettings["codemodeTools"] {
  try { return loadSettings(workflowSettingsPath(agentDir)).codemodeTools; } catch { return undefined; }
}
export function loadSettingsOverrides(path: string): Readonly<WorkflowSettingsOverrides> { return parseSettings(path, true); }
export function resolveWorkflowSettings(cwd: string, projectTrusted: boolean, globalSettingsPath = workflowSettingsPath()): WorkflowSettingsResolution & { selectorSources: AgentResourceSelectorSources } {
  const projectSettingsPath = workflowProjectSettingsPath(cwd);
  const consumerGlobal = loadSettings(globalSettingsPath);
  const consumerProject: Readonly<WorkflowSettingsOverrides> = projectTrusted ? loadSettingsOverrides(projectSettingsPath) : Object.freeze({});
  const composition = roleApi(() => roleSettings.composeRoleConfiguration({ cwd, projectTrusted, agentDir: basename(dirname(globalSettingsPath)) === ROLE_DIRECTORY ? dirname(dirname(globalSettingsPath)) : getAgentDir(), selectorSources: { global: selectorsFromSettings(consumerGlobal), project: selectorsFromSettings(consumerProject) }, modelAliases: consumerProject.modelAliases ?? consumerGlobal.modelAliases ?? {} }));
  const shared = composition.settings;
  const globalExtensionSettings = mergeWorkflowExtensionSettings(shared.global.extensionSettings, consumerGlobal.extensionSettings);
  const projectExtensionSettings = mergeWorkflowExtensionSettings(shared.global.extensionSettings, shared.project.extensionSettings, consumerProject.extensionSettings ?? consumerGlobal.extensionSettings);
  const global: Readonly<WorkflowSettings> = { ...consumerGlobal, ...(globalExtensionSettings === undefined ? {} : { extensionSettings: globalExtensionSettings }) };
  const project: Readonly<WorkflowSettingsOverrides> = { ...consumerProject, ...(shared.project.extensionSettings === undefined && consumerProject.extensionSettings === undefined ? {} : { extensionSettings: projectExtensionSettings ?? {} }) };
  const projectHas = (key: keyof WorkflowSettingsOverrides): boolean => Object.prototype.hasOwnProperty.call(project, key);
  const sourceFor = (key: "skills" | "extensions" | "tools"): string => projectHas(key) ? projectSettingsPath : global[key] !== undefined ? globalSettingsPath : shared.sources[key] ?? shared.globalSettingsPath;
  const globalSelectors = selectorsFromSettings(global);
  const projectSelectors = selectorsFromSettings(project);
  const effectiveSelectors = selectorSet({
    skills: [...(shared.effective.skills ?? []), ...(globalSelectors.skills ?? []), ...(projectSelectors.skills ?? [])],
    extensions: [...(shared.effective.extensions ?? []), ...(globalSelectors.extensions ?? []), ...(projectSelectors.extensions ?? [])],
    ...(shared.effective.tools === undefined && globalSelectors.tools === undefined && projectSelectors.tools === undefined ? {} : { tools: [...(shared.effective.tools ?? []), ...(globalSelectors.tools ?? []), ...(projectSelectors.tools ?? [])] }),
  });
  const hasExtensionSelectors = shared.effective.extensions !== undefined || global.extensions !== undefined || project.extensions !== undefined;
  const extensionSettings = projectHas("extensionSettings") ? project.extensionSettings : global.extensionSettings;
  const sources: WorkflowSettingsSources = {
    concurrency: projectHas("concurrency") ? projectSettingsPath : globalSettingsPath,
    modelAliases: consumerProject.modelAliases !== undefined ? projectSettingsPath : consumerGlobal.modelAliases !== undefined || shared.effective.modelAliases === undefined ? globalSettingsPath : shared.sources.modelAliases ?? shared.globalSettingsPath,
    skills: sourceFor("skills"), extensions: sourceFor("extensions"), tools: sourceFor("tools"),
    ...(extensionSettings === undefined ? {} : { extensionSettings: consumerProject.extensionSettings !== undefined ? projectSettingsPath : consumerGlobal.extensionSettings !== undefined ? globalSettingsPath : shared.sources.extensionSettings ?? shared.globalSettingsPath }),
    ...(project.retention === undefined && global.retention === undefined ? {} : { retention: project.retention === undefined ? globalSettingsPath : projectSettingsPath }),
  };
  const effective = Object.freeze({
    concurrency: project.concurrency ?? global.concurrency,
    backgroundWidget: global.backgroundWidget ?? true,
    ...(shared.effective.modelAliases === undefined && consumerProject.modelAliases === undefined && consumerGlobal.modelAliases === undefined ? {} : { modelAliases: composition.modelAliases }),
    ...(effectiveSelectors.skills.length ? { skills: effectiveSelectors.skills } : shared.effective.skills !== undefined || global.skills !== undefined || project.skills !== undefined ? { skills: effectiveSelectors.skills } : {}),
    ...(hasExtensionSelectors ? { extensions: effectiveSelectors.extensions } : {}),
    ...(extensionSettings === undefined ? {} : { extensionSettings }),
    ...(effectiveSelectors.tools?.length ? { tools: effectiveSelectors.tools } : shared.effective.tools !== undefined || global.tools !== undefined || project.tools !== undefined ? { tools: effectiveSelectors.tools } : {}),
    ...((project.retention ?? global.retention) === undefined ? {} : { retention: project.retention ?? global.retention }),
  });
  validateWorkflowExtensionSettings(effective.extensionSettings, sources.extensionSettings ?? shared.sources.extensionSettings ?? shared.globalSettingsPath);
  return { globalSettingsPath, projectSettingsPath, projectTrusted, global, project, effective, sources, selectorSources: composition.selectorSources };
}
export function validateModelAliasAvailability(aliases: Readonly<Record<string, string>>, names: readonly string[], availableModels: ReadonlySet<string>, knownModels: ReadonlySet<string>, settingsPath?: string): void {
  for (const name of names) {
    try {
      const target = modelCapability(name, aliases, knownModels, settingsPath);
      if (!availableModels.has(target)) unknownModel(name, target, settingsPath);
    } catch (error) { throw annotateModelAliasError(error, name); }
  }
}
export function resolveAgentResourcePolicy(cwd: string, projectTrusted: boolean, globalSettingsPath = workflowSettingsPath()): AgentResourcePolicy {
  const resolved = resolveWorkflowSettings(cwd, projectTrusted, globalSettingsPath);
  const global = selectorSet(selectorsFromSettings(resolved.global));
  const project = selectorSet(selectorsFromSettings(resolved.project));
  const effective = selectorSet(selectorsFromSettings(resolved.effective));
  return { globalSettingsPath: resolved.globalSettingsPath, projectSettingsPath: resolved.projectSettingsPath, projectTrusted, global, project, effective, unmatchedSkills: [], unmatchedExtensions: [], unmatchedTools: [], selectorSources: resolved.selectorSources };
}
export function saveModelAliases(path = workflowSettingsPath(), aliases: Readonly<Record<string, string>> = {}): void {
  const normalized = validateModelAliases(aliases, path);
  let parsed: unknown = {};
  try {
    loadSettings(path);
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", `Workflow settings at ${path} must be an object`);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify({ ...parsed, modelAliases: normalized }, null, 2)}\n`, true);
}

