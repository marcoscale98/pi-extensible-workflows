import { createHash } from "node:crypto";
import { ERROR_CODES, LAUNCH_SNAPSHOT_IDENTITY_VERSION, WorkflowError, type JsonSchema, type JsonValue, type ModelSpec, type WorkflowErrorCode, type WorkflowExtensionSettings } from "./types.js";
import * as roleUtils from "@piewf/pi-ext-roles/utils";
import { RoleError } from "@piewf/pi-ext-roles/types";
export class SerialLane {
  #tail: Promise<void> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

export function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\))`, "g");
const TERMINAL_CONTROL_CHARACTER = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`, "g");
export function sanitizeDisplayText(value: string): string { return value.replace(ANSI_ESCAPE_SEQUENCE, "").replace(TERMINAL_CONTROL_CHARACTER, " "); }
export { object as isObject };
function isStringKey(key: PropertyKey): key is string { return typeof key === "string"; }
function stringKeyValue(value: object, key: string): unknown { return object(value) ? value[key] : undefined; }
function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key] as JsonValue)]));
}
/** A short digest of a JSON value that ignores object key order. */
export function jsonDigest(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(sortedJson(value))).digest("hex").slice(0, 16);
}
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
export function mergeWorkflowExtensionSettings(...layers: readonly (Readonly<WorkflowExtensionSettings> | undefined)[]): Readonly<WorkflowExtensionSettings> | undefined { return roleUtils.mergeExtensionSettings(...layers); }
export function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0; }
export function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function isNodeError(error: unknown, code: string): error is { code: string } { return object(error) && error.code === code; }
export function isWorkflowErrorCode(value: unknown): value is WorkflowErrorCode { return ERROR_CODES.some((candidate) => candidate === value); }
export function errorText(error: unknown): string { return object(error) && typeof error.message === "string" ? error.message : error instanceof Error ? error.message : String(error); }
export function coerceWorkflowError(code: WorkflowErrorCode, error: unknown): WorkflowError {
  return error instanceof WorkflowError && error.code === code ? error : new WorkflowError(code, errorText(error));
}
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
/** Sort order for agent setup hooks: lower priority first, ties broken by name so registration order never matters. */
export function byPriorityThenName(left: { priority: number; name: string }, right: { priority: number; name: string }): number { return left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0); }

export function roleApi<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (!(error instanceof RoleError) && !(error instanceof Error && error.name === "RoleError")) throw error;
    const translated = new WorkflowError(errorCode(error) ?? "INTERNAL_ERROR", errorText(error).replace("Standard roles role directory", "Standard workflow role directory"));
    const alias = roleUtils.modelAliasErrorName(error);
    if (alias) annotateModelAliasError(translated, alias);
    throw translated;
  }
}
export { isThinkingLevel, MODEL_ALIAS_NAME, EXTENSION_NAMESPACE as WORKFLOW_EXTENSION_NAMESPACE, validExtensionNamespace as validWorkflowExtensionNamespace, parseThinking, modelAliasName } from "@piewf/pi-ext-roles/utils";
import { modelAliasName } from "@piewf/pi-ext-roles/utils";
const MODEL_ALIAS_ERROR_NAME = Symbol.for("pi-extensible-workflows.modelAliasErrorName");
export function annotateModelAliasError(error: unknown, name: string): unknown {
  if (error instanceof WorkflowError) Object.defineProperty(error, MODEL_ALIAS_ERROR_NAME, { value: name, configurable: true });
  return error;
}
export function modelAliasErrorName(error: unknown): string | undefined {
  return error instanceof WorkflowError ? (error as WorkflowError & { [MODEL_ALIAS_ERROR_NAME]?: string })[MODEL_ALIAS_ERROR_NAME] : roleUtils.modelAliasErrorName(error);
}
export function parseModelReference(...args: Parameters<typeof roleUtils.parseModelReference>): ReturnType<typeof roleUtils.parseModelReference> { return roleApi(() => roleUtils.parseModelReference(...args)); }
export function assertModelThinking(...args: Parameters<typeof roleUtils.assertModelThinking>): ReturnType<typeof roleUtils.assertModelThinking> { roleApi(() => { roleUtils.assertModelThinking(...args); }); }
export function validateModelAliases(...args: Parameters<typeof roleUtils.validateModelAliases>): ReturnType<typeof roleUtils.validateModelAliases> { return roleApi(() => roleUtils.validateModelAliases(...args)); }
export function unknownModel(...args: Parameters<typeof roleUtils.unknownModel>): ReturnType<typeof roleUtils.unknownModel> { return roleApi(() => roleUtils.unknownModel(...args)); }
export function resolveModelReference(...args: Parameters<typeof roleUtils.resolveModelReference>): ReturnType<typeof roleUtils.resolveModelReference> { return roleApi(() => roleUtils.resolveModelReference(...args)); }
type ToolSource = { getActiveTools(): string[]; getAllTools?(): readonly { name: string; exposure?: string }[] };
/**
 * Tools a session can reach, and so the ceiling for its agents: the declared tools plus the ones
 * only codemode scripts call or tool_search loads, such as MCP tools with the default exposure.
 * Agent sessions allow tools by name, so leaving these out would make them unreachable there.
 */
export function reachableTools(pi: ToolSource): string[] {
  const undeclared = pi.getAllTools?.().filter(({ exposure }) => exposure === "codemode" || exposure === "deferred").map(({ name }) => name) ?? [];
  return [...new Set([...pi.getActiveTools(), ...undeclared])];
}
/** Provider of the virtual models that expose workflow model aliases in `/model`. */
export const VIRTUAL_MODEL_PROVIDER = "workflow";
/** Child sessions do not load the workflow extension, so they receive the alias target instead of its virtual model. */
export function physicalModel(spec: ModelSpec, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  if (spec.provider !== VIRTUAL_MODEL_PROVIDER || !modelAliasName(spec.model, aliases)) return spec;
  const target = resolveModelReference(spec.model, aliases, knownModels, settingsPath);
  return spec.thinking === undefined ? target : { ...target, thinking: spec.thinking };
}
export function modelCapability(...args: Parameters<typeof roleUtils.modelCapability>): string { return roleApi(() => roleUtils.modelCapability(...args)); }
export function aliasDrift(previous: Readonly<Record<string, string>>, current: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort().flatMap((name) => previous[name] === current[name] ? [] : [`${name}: ${previous[name] ?? "(missing)"} -> ${current[name] ?? "(missing)"}`]);
}
export { validateResourcePattern, resourcePatternMatches, selectResourcesByLayers, resourcePatternHasMagic, unmatchedResourcePatterns } from "@piewf/pi-ext-roles/utils";
export function createLaunchSnapshot(input: Omit<import("./types.js").LaunchSnapshot, "identityVersion"> & { identityVersion?: number }): Readonly<import("./types.js").LaunchSnapshot> { return deepFreeze(structuredClone({ ...input, identityVersion: input.identityVersion ?? LAUNCH_SNAPSHOT_IDENTITY_VERSION })); }
export function loadLaunchSnapshot(input: import("./types.js").LaunchSnapshot): Readonly<import("./types.js").LaunchSnapshot> { return deepFreeze(structuredClone(input)); }

export function validateSchema(schema: unknown, at = "schema"): asserts schema is JsonSchema {
  if (!object(schema) || Object.getPrototypeOf(schema) !== Object.prototype || !jsonValue(schema)) fail("INVALID_SCHEMA", `${at} must be a plain JSON-compatible Schema object`);
  if (typeof schema.type !== "string" && !Array.isArray(schema.type) && schema.$ref === undefined && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.const === undefined && schema.enum === undefined) fail("INVALID_SCHEMA", `${at} has no JSON Schema shape`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail("INVALID_SCHEMA", `${at}.required must be an array of strings`);
  if (schema.properties !== undefined && !object(schema.properties)) fail("INVALID_SCHEMA", `${at}.properties must be an object`);
}
