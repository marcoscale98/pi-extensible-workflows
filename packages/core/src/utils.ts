import { ERROR_CODES, LAUNCH_SNAPSHOT_IDENTITY_VERSION, WorkflowError, type AgentResourceExclusions, type JsonValue, type ModelSpec, type WorkflowErrorCode } from "./types.js";
import { Minimatch } from "minimatch";

export function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export { object as isObject };
function isStringKey(key: PropertyKey): key is string { return typeof key === "string"; }
function stringKeyValue(value: object, key: string): unknown { return object(value) ? value[key] : undefined; }
export function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  const keys = ownKeys.filter(isStringKey);
  if (keys.length !== ownKeys.length) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : keys.map((key) => stringKeyValue(value, key))).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}
export function jsonObject(value: unknown): value is Record<string, JsonValue> { return jsonValue(value) && object(value); }
export function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function isNodeError(error: unknown, code: string): error is { code: string } { return object(error) && error.code === code; }
function isWorkflowErrorCode(value: unknown): value is WorkflowErrorCode { return ERROR_CODES.some((candidate) => candidate === value); }
export function errorText(error: unknown): string { return object(error) && typeof error.message === "string" ? error.message : error instanceof Error ? error.message : String(error); }
export function errorCode(error: unknown): WorkflowErrorCode | undefined {
  if (error instanceof WorkflowError) return isWorkflowErrorCode(error.code) ? error.code : undefined;
  if (!object(error)) return undefined;
  return isWorkflowErrorCode(error.code) ? error.code : undefined;
}
const WORKFLOW_AUTHORED_ERROR = Symbol("workflowAuthoredError");
export function markWorkflowAuthored(error: WorkflowError, authored = false): WorkflowError {
  if (authored) Object.defineProperty(error, WORKFLOW_AUTHORED_ERROR, { value: true });
  return error;
}
export function isWorkflowAuthored(error: unknown): boolean { return Boolean(error && typeof error === "object" && WORKFLOW_AUTHORED_ERROR in error); }
export function asWorkflowError(error: unknown): WorkflowError {
  const code = errorCode(error);
  return markWorkflowAuthored(error instanceof WorkflowError && code ? error : new WorkflowError(code ?? "INTERNAL_ERROR", errorText(error)), isWorkflowAuthored(error) || !code);
}
export function fail(code: WorkflowErrorCode, message: string): never { throw new WorkflowError(code, message); }

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = NonNullable<ModelSpec["thinking"]>;
function isThinkingLevel(value: unknown): value is ThinkingLevel { return typeof value === "string" && THINKING_LEVELS.some((level) => level === value); }
const MODEL_ALIAS_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export function parseThinking(value: unknown): ModelSpec["thinking"] | undefined { return isThinkingLevel(value) ? value : undefined; }
export function parseModelReference(value: string): ModelSpec {
  const match = /^([^/:\s]+)\/([^:\s]+)(?::([^:\s]+))?$/.exec(value);
  if (!match?.[1] || !match[2]) fail("UNKNOWN_MODEL", `Invalid model spec: ${value}`);
  const thinking = match[3];
  if (thinking !== undefined && !isThinkingLevel(thinking)) fail("UNKNOWN_MODEL", `Invalid thinking level: ${thinking}`);
  return { provider: match[1], model: match[2], ...(thinking !== undefined ? { thinking } : {}) };
}
const MODEL_ALIAS_ERROR_NAME = Symbol("modelAliasErrorName");
type ModelAliasError = WorkflowError & { [MODEL_ALIAS_ERROR_NAME]?: string };
function aliasError(message: string, settingsPath: string, name?: string): never {
  const error = new WorkflowError("CONFIG_ERROR", `${message} (settings: ${settingsPath})`);
  if (name) Object.defineProperty(error, MODEL_ALIAS_ERROR_NAME, { value: name, configurable: true });
  throw error;
}
export function annotateModelAliasError(error: unknown, name: string): unknown {
  if (error instanceof WorkflowError) Object.defineProperty(error, MODEL_ALIAS_ERROR_NAME, { value: name, configurable: true });
  return error;
}
export function modelAliasErrorName(error: unknown): string | undefined {
  return error instanceof WorkflowError ? (error as ModelAliasError)[MODEL_ALIAS_ERROR_NAME] : undefined;
}
export function modelAliasName(value: string, aliases: Readonly<Record<string, string>>): string | undefined {
  const name = /^([^/:\s]+)(?::[^:\s]+)?$/.exec(value)?.[1];
  return name && Object.prototype.hasOwnProperty.call(aliases, name) ? name : undefined;
}
export function validateModelAliases(value: unknown, settingsPath = "workflow settings"): Readonly<Record<string, string>> {
  if (!object(value)) aliasError("modelAliases must be an object", settingsPath);
  const aliases: Record<string, string> = {};
  for (const [name, target] of Object.entries(value)) {
    if (!MODEL_ALIAS_NAME.test(name)) aliasError(`Invalid model alias name: ${name}`, settingsPath, name);
    if (typeof target !== "string" || !target.trim()) aliasError(`Invalid model alias target for ${name}`, settingsPath, name);
    aliases[name] = target;
  }
  for (const name of Object.keys(aliases)) {
    try { resolveModelReference(name, aliases); } catch (error) { aliasError(`Invalid model alias target for ${name}: ${errorText(error)}`, settingsPath, name); }
  }
  return Object.freeze(aliases);
}
export function unknownModel(value: string, target: string | undefined, settingsPath?: string): never {
  const resolved = target ? ` resolved to ${target}` : "";
  const path = settingsPath ? ` (settings: ${settingsPath})` : "";
  fail("UNKNOWN_MODEL", `Unknown model${target ? " alias" : ""} ${value}${resolved}${path}`);
}
export function resolveModelReference(value: string, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  const resolveReference = (reference: string, chain: readonly string[]): ModelSpec => {
    if (reference.includes("/")) return parseModelReference(reference);
    const match = /^([^:\s]+)(?::([^:\s]+))?$/.exec(reference);
    const thinking = match?.[2];
    if (!match?.[1] || thinking !== undefined && !isThinkingLevel(thinking)) unknownModel(reference, undefined, settingsPath);
    const alias = modelAliasName(reference, aliases);
    if (alias) {
      if (chain.includes(alias)) fail("UNKNOWN_MODEL", `Circular model alias: ${[...chain, alias].join(" -> ")}${settingsPath ? ` (settings: ${settingsPath})` : ""}`);
      const { [alias]: target } = aliases;
      if (typeof target !== "string") unknownModel(reference, undefined, settingsPath);
      const parsed = resolveReference(target, [...chain, alias]);
      return thinking !== undefined ? { ...parsed, thinking } : parsed;
    }
    const candidates = [...(knownModels ?? [])].filter((model) => model.slice(model.indexOf("/") + 1) === match[1]);
    if (candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate !== undefined) {
        const parsed = parseModelReference(candidate);
        return thinking !== undefined ? { ...parsed, thinking } : parsed;
      }
    }
    unknownModel(reference, undefined, settingsPath);
  };
  return resolveReference(value, []);
}
export function modelCapability(value: string | ModelSpec, aliases?: Readonly<Record<string, string>>, knownModels?: ReadonlySet<string>, settingsPath?: string): string {
  const parsed = typeof value === "string" ? resolveModelReference(value, aliases, knownModels, settingsPath) : value;
  return `${parsed.provider}/${parsed.model}`;
}
export function aliasDrift(previous: Readonly<Record<string, string>>, current: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort().flatMap((name) => previous[name] === current[name] ? [] : [`${name}: ${previous[name] ?? "(missing)"} -> ${current[name] ?? "(missing)"}`]);
}
const RESOURCE_PATTERN_OPTIONS = { dot: true, nonegate: true, nocomment: true } as const;
function resourcePatternBody(pattern: string): string { return pattern.startsWith("!") ? pattern.slice(1) : pattern; }
function resourcePatternPath(value: string): string { return value.replaceAll("\\", "/"); }
export function validateResourcePattern(pattern: string): void {
  const body = resourcePatternBody(pattern);
  if (!body) throw new Error(`Empty minimatch pattern ${JSON.stringify(pattern)}`);
  const matcher = new Minimatch(resourcePatternPath(body), RESOURCE_PATTERN_OPTIONS);
  if (matcher.makeRe() === false) throw new Error(`Invalid minimatch pattern ${JSON.stringify(pattern)}`);
}
export function resourcePatternMatches(resource: string, pattern: string): boolean {
  const body = resourcePatternBody(pattern);
  if (body === "*") return true;
  return new Minimatch(resourcePatternPath(body), RESOURCE_PATTERN_OPTIONS).match(resourcePatternPath(resource));
}
export function selectResources(patterns: readonly string[], resources: readonly string[], defaultEnabled = true): string[] {
  return resources.filter((resource) => {
    let enabled = defaultEnabled;
    for (const pattern of patterns) if (resourcePatternMatches(resource, pattern)) enabled = !pattern.startsWith("!");
    return enabled;
  });
}
export function unmatchedResourcePatterns(patterns: readonly string[], resources: readonly string[]): string[] { return patterns.filter((pattern) => !resources.some((resource) => resourcePatternMatches(resource, pattern))); }
export function mergeAgentResourceSelectors(...values: (import("./types.js").AgentResourceSelectors | undefined)[]): import("./types.js").AgentResourceSelectors {
  return {
    skills: values.flatMap((value) => value?.skills ?? []),
    extensions: values.flatMap((value) => value?.extensions ?? []),
    tools: values.flatMap((value) => value?.tools ?? []),
  };
}
export function disabledResources(patterns: readonly string[], resources: readonly string[]): string[] {
  const disabled = new Set<string>();
  for (const resource of resources) {
    let excluded = false;
    for (const pattern of patterns) if (resourcePatternMatches(resource, pattern)) excluded = !pattern.startsWith("!");
    if (excluded) disabled.add(resource);
  }
  return [...disabled];
}
export function mergeAgentResourceExclusions(...values: (AgentResourceExclusions | undefined)[]): AgentResourceExclusions { return { skills: values.flatMap((value) => value?.skills ?? []), extensions: values.flatMap((value) => value?.extensions ?? []) }; }
export function createLaunchSnapshot(input: Omit<import("./types.js").LaunchSnapshot, "identityVersion"> & { identityVersion?: number }): Readonly<import("./types.js").LaunchSnapshot> { return deepFreeze(structuredClone({ ...input, identityVersion: input.identityVersion ?? LAUNCH_SNAPSHOT_IDENTITY_VERSION })); }
export function loadLaunchSnapshot(input: import("./types.js").LaunchSnapshot): Readonly<import("./types.js").LaunchSnapshot> { return deepFreeze(structuredClone(input)); }
