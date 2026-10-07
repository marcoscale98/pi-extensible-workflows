import { fileURLToPath } from "node:url";
import { collectRoleContributions, type RoleDirectoryRegistration } from "@piewf/pi-ext-roles";
import { composeRoleConfiguration, loadSettings as loadSharedRoleSettings, roleSettingsPath, roleProjectSettingsPath } from "@piewf/pi-ext-roles/settings";
import { canonicalExtensionSelector, roleDirectories } from "@piewf/pi-ext-roles/roles";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Credential } from "@earendil-works/pi-ai";
import {
  createEventBus,
  ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SETTINGS,
  canonicalPath,
  createLocalPiSession,
  errorText,
  isNodeError,
  isObject,
  loadSettings,
  prepareAgentSetupForInspection,
  resolveAgentResourcePolicy,
  resolveWorkflowSettings,
  resolveModelReference,
  resourcePatternHasMagic,
  parseThinking,
  registeredWorkflowFunctions,
  workflowProjectSettingsPath,
  workflowSettingsPath,
  type AgentExecutionOptions,
  type AgentExecutionRoot,
  type AgentResourcePolicy,
  type AgentTransport,
  type WorkflowCatalogModelAlias,
  type WorkflowExtensionMetadata,
  type WorkflowFunction,
  type WorkflowSettings,
  type WorkflowSettingsSources,
} from "pi-extensible-workflows";
import type { AgentDefinition } from "pi-extensible-workflows";
import { parseRoleMarkdown, legacyRoleSources } from "pi-extensible-workflows/roles";
import { loadingRegistry, type WorkflowRegistryApi } from "pi-extensible-workflows";
import { selectResourcesByLayers, unmatchedResourcePatterns, mergeWorkflowExtensionSettings } from "pi-extensible-workflows";
export type DoctorSeverity = "error" | "warning";
export interface DoctorDiagnostic { severity: DoctorSeverity; code: string; message: string; source?: string; hint?: string }
export interface DoctorRole { name: string; path: string; scope: "extension" | "global" | "project"; active: boolean; overrides?: string; overriddenBy?: string; extension?: WorkflowExtensionMetadata; provenance?: RoleDirectoryRegistration }
export interface DoctorFunction { name: string; description: string; valid: boolean }
export interface DoctorTrust { required: boolean; trusted: boolean; source: string }
export interface DoctorRoleInspection {
  role: string;
  path: string;
  model: { provider: string; model: string; thinking?: string; inherited?: boolean };
  tools: readonly string[];
  resources: { selectors: { skills: readonly string[]; extensions: readonly string[]; tools: readonly string[] }; skills: readonly string[]; extensions: readonly string[]; tools: readonly string[]; unmatchedSkills: readonly string[]; unmatchedExtensions: readonly string[]; unmatchedTools: readonly string[]; selectorSources?: NonNullable<AgentResourcePolicy["selectorSources"]> };
  systemPrompt: { probe: string; expandedProbe: string; text: string; source?: string };
  setup: { hooks: readonly string[]; diagnostics: readonly DoctorDiagnostic[] };
}
export interface DoctorPiState {
  trust: DoctorTrust;
  model?: { provider: string; model: string; thinking?: string };
  activeTools: readonly string[];
  knownModels: readonly string[];
  availableModels: readonly string[];
  extensionErrors: readonly { path?: string; message: string }[];
  extensions?: readonly string[];
  skills?: readonly string[];
  functions: Readonly<Record<string, WorkflowFunction>>;
  roleSources?: readonly RoleDirectoryRegistration[];
}
export interface DoctorReport {
  cwd: string;
  agentDir: string;
  settingsPath: string;
  settings: Readonly<WorkflowSettings>;
  settingsSources: WorkflowSettingsSources;
  sharedRoleSettings?: ReturnType<typeof composeRoleConfiguration>["settings"];
  trust: DoctorTrust;
  activeTools: readonly string[];
  piExtensions: readonly string[];
  piSkills: readonly string[];
  roles: readonly DoctorRole[];
  functions: readonly DoctorFunction[];
  resourcePolicy: AgentResourcePolicy;
  modelAliases: readonly WorkflowCatalogModelAlias[];
  roleTarget?: string;
  roleInspection?: DoctorRoleInspection;
  diagnostics: readonly DoctorDiagnostic[];
}
export interface DoctorOptions {
  cwd?: string;
  agentDir?: string;
  settingsPath?: string;
  role?: string;
  prompt?: string;
  discoverPi?: (cwd: string, agentDir: string) => Promise<DoctorPiState>;
  activeTools?: readonly string[];
  registry?: WorkflowRegistryApi;
}

const THINKING_HINT = "Use off, minimal, low, medium, high, xhigh, or max.";
const AGENT_RESOURCE_SELECTOR_MIGRATION_ISSUE = "https://github.com/vekexasia/pi-extensible-workflows/issues/205";
const AGENT_RESOURCE_SELECTOR_MIGRATION_MESSAGE = `\`disabledAgentResources\` is no longer supported by #205. Migrate to direct \`skills\`, \`extensions\`, and \`tools\` selectors: legacy patterns exclude resources and \`!pattern\` re-enables them, while new selectors include matches and \`!pattern\` excludes them. See ${AGENT_RESOURCE_SELECTOR_MIGRATION_ISSUE}`;

function usesLegacySettings(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "disabledAgentResources");
  } catch { return false; }
}
function usesLegacyRoleSelectors(path: string): boolean {
  try { return /^\s*disabledAgentResources\s*:/m.test(readFileSync(path, "utf8")); }
  catch { return false; }
}

function isDynamicModelAlias(value: string, aliases: ReadonlySet<string>): boolean {
  const match = /^([^/\s:]+)(?::([^\s]+))?$/.exec(value);
  const name = match?.[1];
  return Boolean(name && (match[2] === undefined || parseThinking(match[2]) !== undefined) && aliases.has(name));
}
function isCredential(value: unknown): value is Credential {
  if (!isObject(value)) return false;
  if (value.type === "api_key") return (value.key === undefined || typeof value.key === "string") && (value.env === undefined || isObject(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
  return value.type === "oauth" && typeof value.refresh === "string" && typeof value.access === "string" && typeof value.expires === "number";
}
async function readCredentials(agentDir: string): Promise<InMemoryCredentialStore> {
  const credentials = new InMemoryCredentialStore();
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    if (!isObject(parsed)) throw new Error("Pi auth.json must be an object");
    await Promise.all(Object.entries(parsed).flatMap(([provider, credential]) => isCredential(credential) ? [credentials.modify(provider, async () => credential)] : []));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  return credentials;
}

function savedTrust(cwd: string, agentDir: string): boolean | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")); }
  catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
  if (!isObject(parsed)) throw new Error("Pi trust.json must be an object");
  let current = canonicalPath(cwd);
  while (current !== dirname(current)) {
    const value = parsed[current];
    if (value === true || value === false) return value;
    current = dirname(current);
  }
  const value = parsed[current];
  return value === true || value === false ? value : undefined;
}

async function discoverPi(cwd: string, agentDir: string): Promise<DoctorPiState> {
  const required = hasTrustRequiringProjectResources(cwd);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const saved = required ? savedTrust(cwd, agentDir) : true;
  const fallback = settingsManager.getDefaultProjectTrust();
  const trusted = !required || saved !== undefined ? Boolean(saved) : fallback === "always";
  const source = !required ? "no trust-gated project resources" : saved !== undefined ? "saved Pi trust decision" : `headless defaultProjectTrust=${fallback}`;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const modelRuntime = await ModelRuntime.create({ credentials: await readCredentials(agentDir), modelsPath: join(agentDir, "models.json"), modelsStore: new InMemoryModelsStore() });
    const bus = createEventBus();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: { eventBus: bus, noPromptTemplates: true, noThemes: true, noContextFiles: true },
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
    });
    const allModels = services.modelRuntime.getModels();
    const availableModels = await services.modelRuntime.getAvailable();
    const model = availableModels[0] ?? allModels[0];
    if (!model) throw new Error("Pi has no models registered");
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model });
    try {
      const activeTools = session.agent.state.tools.map(({ name }) => name).filter((name) => name !== "workflow" && name !== "workflow_respond" && name !== "workflow_catalog");
      const extensions = services.resourceLoader.getExtensions();
      const skills = services.resourceLoader.getSkills().skills;
      return {
        trust: { required, trusted, source },
        model: { provider: model.provider, model: model.id, thinking: session.thinkingLevel },
        activeTools,
        knownModels: allModels.map(({ provider, id }) => `${provider}/${id}`),
        availableModels: availableModels.map(({ provider, id }) => `${provider}/${id}`),
        extensions: extensions.extensions.map(({ resolvedPath }) => resolvedPath),
        skills: skills.map(({ name }) => name),
        extensionErrors: [
          ...extensions.errors.map(({ path, error }) => ({ path, message: error })),
          ...services.diagnostics.filter(({ type }) => type === "error").map(({ message }) => ({ message })),
        ],
        functions: registeredWorkflowFunctions(),
        roleSources: collectRoleContributions(bus, extensions),
      };
    } finally { session.dispose(); bus.clear(); }
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
}

function isRoleFile(dir: string, entry: import("node:fs").Dirent): boolean {
  if (extname(entry.name) !== ".md") return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(join(dir, entry.name)).isFile(); }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
}
function roleFiles(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => isRoleFile(dir, entry)).map((entry) => join(dir, entry.name)).sort(); }
  catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
}

type ExtensionRoleFile = { name: string; path: string; directory: string; extension: WorkflowExtensionMetadata; builtin?: true };
type ExtensionRoleScan = { files: ExtensionRoleFile[]; empty: RoleDirectoryRegistration[]; errors: Array<{ registration: RoleDirectoryRegistration; error: unknown }> };
function extensionLabel(extension: WorkflowExtensionMetadata): string { return `Extension "${extension.headline}" (${extension.version})`; }
function scanExtensionRoleFiles(registrations: readonly RoleDirectoryRegistration[]): ExtensionRoleScan {
  const files: ExtensionRoleFile[] = [];
  const empty: RoleDirectoryRegistration[] = [];
  const errors: Array<{ registration: RoleDirectoryRegistration; error: unknown }> = [];
  for (const registration of registrations) {
    try {
      const entries = readdirSync(registration.path, { withFileTypes: true });
      const roleFiles = entries.filter((entry) => isRoleFile(registration.path, entry));
      if (!roleFiles.length) empty.push(registration);
      for (const entry of roleFiles) files.push({ name: basename(entry.name, ".md"), path: join(registration.path, entry.name), directory: registration.path, extension: registration.extension ?? { headline: "Role contributor", version: "unknown" }, ...(registration.builtin === true ? { builtin: true as const } : {}) });
    } catch (error) { errors.push({ registration, error }); }
  }
  files.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return { files, empty, errors };
}
function roleProvenance(source?: { directory: string; extension: WorkflowExtensionMetadata }): string {
  return source ? `${extensionLabel(source.extension)} role directory "${source.directory}"` : "Role";
}
function diagnostic(severity: DoctorSeverity, code: string, message: string, source?: string, hint?: string): DoctorDiagnostic {
  return { severity, code, message, ...(source ? { source } : {}), ...(hint ? { hint } : {}) };
}
function legacyAgentResourceSelectorDiagnostic(source: string): DoctorDiagnostic {
  return diagnostic("error", "AGENT_RESOURCE_SELECTOR_MIGRATION", AGENT_RESOURCE_SELECTOR_MIGRATION_MESSAGE, source, "Replace disabledAgentResources with direct selectors and use !* before positive allow-list patterns.");
}
function positiveOnlyToolSelectorDiagnostic(source: string, selectors: readonly string[] | undefined): DoctorDiagnostic | undefined {
  if (!selectors?.length || selectors.some((selector) => selector.startsWith("!"))) return undefined;
  return diagnostic("warning", "AGENT_RESOURCE_TOOL_SELECTOR_ALLOWLIST", "Positive-only tool selectors do not restrict the default-enabled candidate set.", `${source}.tools`, "Prepend !* before positive patterns to make this an allow-list.");
}
function emptyResourcePolicy(globalSettingsPath: string, cwd: string, projectTrusted: boolean): AgentResourcePolicy {
  const empty = { skills: [], extensions: [], tools: [] };
  return { globalSettingsPath, projectSettingsPath: workflowProjectSettingsPath(cwd), projectTrusted, global: empty, project: empty, effective: empty, unmatchedSkills: [], unmatchedExtensions: [], unmatchedTools: [], selectorSources: { global: {}, project: {} } };
}
function validateModel(value: string, known: ReadonlySet<string>, available: ReadonlySet<string>, source: string, diagnostics: DoctorDiagnostic[], aliases: Readonly<Record<string, string>>, dynamicAliases: ReadonlySet<string>, settingsPath: string): void {
  if (isDynamicModelAlias(value, dynamicAliases)) return;
  try {
    const parsed = resolveModelReference(value, aliases, known, settingsPath);
    const name = `${parsed.provider}/${parsed.model}`;
    if (!known.has(name) || !available.has(name)) diagnostics.push(diagnostic("warning", "MODEL_UNAVAILABLE", `Model is valid-shaped but unavailable: ${name}`, source));
  } catch (error) {
    const message = errorText(error);
    diagnostics.push(diagnostic("error", "MODEL_INVALID", message, source, message.includes("thinking") ? THINKING_HINT : "Use provider/model:thinking."));
  }
}

function parseRole(path: string, diagnostics: DoctorDiagnostic[], source?: { directory: string; extension: WorkflowExtensionMetadata }): AgentDefinition | undefined {
  try { return parseRoleMarkdown(readFileSync(path, "utf8"), true, path); }
  catch (error) {
    if (usesLegacyRoleSelectors(path)) {
      diagnostics.push(legacyAgentResourceSelectorDiagnostic(path));
      return undefined;
    }
    const message = errorText(error);
    diagnostics.push(diagnostic("error", "ROLE_FRONTMATTER", source ? `${roleProvenance(source)} contains invalid role at "${path}": ${message}` : message, path, "Fix the role YAML frontmatter."));
    return undefined;
  }
}
function inspectRoleUsage(path: string, definition: AgentDefinition, activeTools: ReadonlySet<string>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, diagnostics: DoctorDiagnostic[], aliases: Readonly<Record<string, string>>, dynamicAliases: ReadonlySet<string>, settingsPath: string): void {
  const toolSelectorDiagnostic = positiveOnlyToolSelectorDiagnostic(path, definition.tools);
  if (toolSelectorDiagnostic) diagnostics.push(toolSelectorDiagnostic);
  const body = definition.prompt ?? "";
  if (body.trim() === "") diagnostics.push(diagnostic("warning", "ROLE_BODY_EMPTY", "Role body is empty", path));
  if (Buffer.byteLength(body) > 50 * 1024) diagnostics.push(diagnostic("warning", "ROLE_BODY_LARGE", "Role body exceeds 50KB", path));
  if (/{{\s*[^{}]+\s*}}/.test(body)) diagnostics.push(diagnostic("warning", "ROLE_PLACEHOLDER", "Role body contains an unsupported placeholder-looking token", path));
  if (definition.model) validateModel(definition.model, knownModels, availableModels, path, diagnostics, aliases, dynamicAliases, settingsPath);
  for (const selector of definition.tools ?? []) {
    const tool = selector.startsWith("!") ? selector.slice(1) : selector;
    if (!selector.startsWith("!") && !resourcePatternHasMagic(selector) && !activeTools.has(tool)) diagnostics.push(diagnostic("warning", "ROLE_TOOL_INACTIVE", `Tool is not in Pi's headless active tool list: ${tool}`, path, "Doctor cannot see tools that extensions add when a session starts; otherwise use a tool listed under Pi active tools or enable its Pi extension."));
  }
}
function inspectRole(path: string, activeTools: ReadonlySet<string>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, diagnostics: DoctorDiagnostic[], aliases: Readonly<Record<string, string>>, dynamicAliases: ReadonlySet<string>, settingsPath: string, source?: { directory: string; extension: WorkflowExtensionMetadata }): AgentDefinition | undefined {
  const definition = parseRole(path, diagnostics, source);
  if (definition) inspectRoleUsage(path, definition, activeTools, knownModels, availableModels, diagnostics, aliases, dynamicAliases, settingsPath);
  return definition;
}

function matchResourcePolicy(policy: AgentResourcePolicy, pi: DoctorPiState): AgentResourcePolicy {
  const extensions = [...new Set((pi.extensions ?? []).map(canonicalPath))];
  const skills = [...new Set(pi.skills ?? [])];
  const tools = [...new Set(pi.activeTools)];
  const layers = policy.selectorSources;
  const selectedSkills = selectResourcesByLayers([layers.defaults?.global.skills, layers.defaults?.project.skills, layers.global.skills, layers.project.skills], skills);
  const selectedExtensions = selectResourcesByLayers([layers.defaults?.global.extensions, layers.defaults?.project.extensions, layers.global.extensions, layers.project.extensions], extensions);
  const selectedTools = selectResourcesByLayers([layers.defaults?.global.tools, layers.defaults?.project.tools, layers.global.tools, layers.project.tools], tools);
  return { ...policy, selectedSkills, selectedExtensions, selectedTools, unmatchedSkills: unmatchedResourcePatterns(policy.effective.skills, skills), unmatchedExtensions: unmatchedResourcePatterns(policy.effective.extensions, extensions), unmatchedTools: unmatchedResourcePatterns(policy.effective.tools ?? [], tools) };
}
async function inspectRoleSession(cwd: string, agentDir: string, roleName: string, definition: AgentDefinition, rolePath: string, basePolicy: AgentResourcePolicy, rootModel: { provider: string; model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }, activeTools: readonly string[], aliases: Readonly<Record<string, string>>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, settingsPath: string, extensionSettings: Readonly<WorkflowSettings["extensionSettings"]> | undefined, prompt: string, hooks: NonNullable<AgentExecutionRoot["agentSetupHooks"]>, diagnostics: DoctorDiagnostic[]): Promise<DoctorRoleInspection | undefined> {
  const setupDiagnostics: DoctorDiagnostic[] = [];
  const signal = new AbortController().signal;
  const transport: AgentTransport = { id: "doctor-local", createSession: async () => { throw new Error("Doctor inspection does not create transport sessions"); } };
  const run = { cwd, sessionId: "doctor", runId: "doctor", workflow: { name: "doctor" }, args: null, signal };
  const root: AgentExecutionRoot = { cwd, projectTrusted: basePolicy.projectTrusted, model: { ...rootModel }, tools: new Set(activeTools), resourceSelectors: basePolicy.effective, agentDefinitions: { [roleName]: definition }, agentDir, extensionSettings, modelAliases: aliases, knownModels, availableModels, settingsPath, agentSetupHooks: hooks, agentResourcePolicy: () => structuredClone(basePolicy), runContext: run };
  const options: AgentExecutionOptions = { label: roleName, workflowName: "doctor", role: roleName };
  let prepared: Awaited<ReturnType<typeof prepareAgentSetupForInspection>>;
  try { prepared = await prepareAgentSetupForInspection(root, prompt, options, transport); }
  catch (error) { setupDiagnostics.push(diagnostic("error", "ROLE_INSPECTION", errorText(error), rolePath)); diagnostics.push(...setupDiagnostics); return undefined; }
  if (prepared.failure) {
    const error = prepared.failure.error;
    const code = prepared.failure.hook ? "ROLE_SETUP_HOOK" : "ROLE_INSPECTION";
    setupDiagnostics.push(diagnostic("error", code, `${prepared.failure.hook ? `Role setup hook ${prepared.failure.hook} failed: ` : ""}${errorText(error)}`, prepared.failure.hook ?? rolePath));
    diagnostics.push(...setupDiagnostics);
    return undefined;
  }
  const session = await (async () => { try { return await createLocalPiSession({ ...prepared.setup.sessionInput, sessionManager: SessionManager.inMemory() }); } catch (error) { setupDiagnostics.push(diagnostic("error", "ROLE_INSPECTION", errorText(error), rolePath)); return undefined; } })();
  if (!session) { diagnostics.push(...setupDiagnostics); return undefined; }
  try {
    const promptResult = await session.preparePrompt(prompt);
    const resources = session.getResourceInspection();
    const state = session.agent?.state;
    const inherited = prepared.setup.sessionInput.model.provider === rootModel.provider && prepared.setup.sessionInput.model.model === rootModel.model && prepared.setup.sessionInput.model.thinking === rootModel.thinking;
    const actualModel = session.model?.provider && (session.model.model ?? session.model.id) ? { provider: session.model.provider, model: session.model.model ?? session.model.id ?? prepared.setup.sessionInput.model.model, ...(session.thinkingLevel ? { thinking: session.thinkingLevel } : {}), ...(inherited ? { inherited: true } : {}) } : { ...prepared.setup.sessionInput.model, ...(inherited ? { inherited: true } : {}) };
    const policy = prepared.setup.sessionInput.resourcePolicy ?? basePolicy;
    for (const item of [...resources.diagnostics, ...promptResult.diagnostics]) setupDiagnostics.push(diagnostic(item.type === "error" ? "error" : "warning", "ROLE_INSPECTION", item.message, item.source));
    return { role: roleName, path: rolePath, model: actualModel, tools: state?.tools.map(({ name }) => name) ?? [...prepared.setup.sessionInput.tools], resources: { selectors: { skills: [...policy.effective.skills], extensions: [...policy.effective.extensions], tools: [...(policy.effective.tools ?? [])] }, skills: policy.selectedSkills ?? resources.skills, extensions: policy.selectedExtensions ?? resources.extensions, tools: policy.selectedTools ?? prepared.setup.sessionInput.tools, unmatchedSkills: policy.unmatchedSkills, unmatchedExtensions: policy.unmatchedExtensions, unmatchedTools: policy.unmatchedTools ?? [], selectorSources: policy.selectorSources }, systemPrompt: { probe: prompt, expandedProbe: promptResult.expandedPrompt, text: promptResult.systemPrompt, ...(resources.systemPromptSource ? { source: resources.systemPromptSource } : {}) }, setup: { hooks: prepared.summary.hookNames, diagnostics: setupDiagnostics } };
  } catch (error) { setupDiagnostics.push(diagnostic("error", "ROLE_INSPECTION", errorText(error), rolePath)); diagnostics.push(...setupDiagnostics); return undefined; }
  finally { await session.dispose(); }
}
function resourcePolicySource(settingsSource: string): string { return settingsSource; }
function validateDoctorExtensionSettings(registry: WorkflowRegistryApi, value: Readonly<WorkflowSettings["extensionSettings"]>, source: "global" | "project" | "effective" | "role", cwd: string, projectTrusted: boolean, settingsPath: string, diagnostics: DoctorDiagnostic[], role?: string): void {
  try { registry.validateExtensionSettings(value, { source, cwd, projectTrusted, settingsPath, ...(role === undefined ? {} : { role }) }); }
  catch (error) { diagnostics.push(diagnostic("error", "SETTINGS_INVALID", errorText(error), `${settingsPath}.extensionSettings`, "Fix the extension-owned settings reported in this error.")); }
}
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = canonicalPath(options.cwd ?? process.cwd());
  const agentDir = canonicalPath(options.agentDir ?? getAgentDir());
  const settingsPath = canonicalPath(options.settingsPath ?? workflowSettingsPath(agentDir));
  const projectSettingsPath = workflowProjectSettingsPath(cwd);
  const legacyGlobalSettings = usesLegacySettings(settingsPath);
  const diagnostics: DoctorDiagnostic[] = [];
  const registry = options.registry ?? loadingRegistry();
  let settings = DEFAULT_SETTINGS;
  try { settings = loadSettings(settingsPath); }
  catch (error) { diagnostics.push(diagnostic("error", "SETTINGS_INVALID", errorText(error), settingsPath, "Fix or remove the invalid workflow settings file.")); }
  let settingsSources: WorkflowSettingsSources = { concurrency: settingsPath, modelAliases: settingsPath, skills: settingsPath, extensions: settingsPath, tools: settingsPath };

  let pi: DoctorPiState;
  try { pi = await (options.discoverPi ?? discoverPi)(cwd, agentDir); }
  catch (error) {
    diagnostics.push(diagnostic("error", "PI_DISCOVERY", `Pi headless discovery failed: ${errorText(error)}`, undefined, "Open and trust the project in Pi, fix extension errors, then rerun doctor."));
    pi = { trust: { required: false, trusted: false, source: "discovery failed" }, activeTools: [], knownModels: [], availableModels: [], extensionErrors: [], functions: {} };
  }
  if (options.activeTools) pi = { ...pi, activeTools: options.activeTools.filter((tool) => tool !== "workflow" && tool !== "workflow_respond" && tool !== "workflow_catalog") };
  if (pi.trust.required && !pi.trust.trusted) diagnostics.push(diagnostic("warning", "PROJECT_UNTRUSTED", "Pi project resources are inactive because the project is not trusted", cwd, "Open this project in Pi, choose Trust, then rerun doctor."));
  const legacyProjectSettings = pi.trust.trusted && usesLegacySettings(projectSettingsPath);
  if (legacyGlobalSettings) diagnostics.push(legacyAgentResourceSelectorDiagnostic(`${settingsPath}.disabledAgentResources`));
  if (legacyProjectSettings) diagnostics.push(legacyAgentResourceSelectorDiagnostic(`${projectSettingsPath}.disabledAgentResources`));
  for (const error of pi.extensionErrors) diagnostics.push(diagnostic("error", "EXTENSION_LOAD", error.message, error.path, "Fix or disable the failing Pi extension."));
  try {
    const resolved = resolveWorkflowSettings(cwd, pi.trust.trusted, settingsPath);
    settings = resolved.effective;
    settingsSources = resolved.sources;
    if (resolved.global.extensionSettings !== undefined) validateDoctorExtensionSettings(registry, resolved.global.extensionSettings, "global", cwd, pi.trust.trusted, resolved.globalSettingsPath, diagnostics);
    if (pi.trust.trusted && resolved.project.extensionSettings !== undefined) validateDoctorExtensionSettings(registry, resolved.project.extensionSettings, "project", cwd, true, resolved.projectSettingsPath, diagnostics);
    validateDoctorExtensionSettings(registry, resolved.effective.extensionSettings, "effective", cwd, pi.trust.trusted, settingsSources.extensionSettings ?? settingsPath, diagnostics);
  } catch (error) {
    const message = errorText(error);
    const source = [roleProjectSettingsPath(cwd), roleSettingsPath(agentDir), projectSettingsPath].find(path => message.includes(path)) ?? settingsPath;
    if (!diagnostics.some(({ code, source: itemSource }) => code === "SETTINGS_INVALID" && itemSource === source)) diagnostics.push(diagnostic("error", "SETTINGS_INVALID", message, source, "Fix or remove the invalid workflow settings file."));
  }
  for (const source of [roleSettingsPath(agentDir), ...(pi.trust.trusted ? [roleProjectSettingsPath(cwd)] : [])]) {
    try { loadSharedRoleSettings(source); }
    catch (error) { if (!diagnostics.some(item => item.code === "SETTINGS_INVALID" && item.source === source)) diagnostics.push(diagnostic("error", "SETTINGS_INVALID", errorText(error), source, "Fix the shared role settings file.")); }
  }
  let sharedRoleSettings: DoctorReport["sharedRoleSettings"];
  let consumerModelAliases: Readonly<Record<string, string>> = {};
  let consumerAliasSource = settingsPath;
  let resourcePolicy: AgentResourcePolicy;
  try {
    const consumerGlobal = loadSettings(settingsPath);
    const consumerProject: Partial<WorkflowSettings> = pi.trust.trusted ? loadSettings(projectSettingsPath) : {};
    const policy = resolveAgentResourcePolicy(cwd, pi.trust.trusted, settingsPath);
    const composition = composeRoleConfiguration({ cwd, agentDir, projectTrusted: pi.trust.trusted, selectorSources: policy.selectorSources, modelAliases: consumerProject.modelAliases ?? consumerGlobal.modelAliases ?? {} });
    sharedRoleSettings = composition.settings;
    consumerModelAliases = consumerProject.modelAliases ?? consumerGlobal.modelAliases ?? {};
    consumerAliasSource = consumerProject.modelAliases === undefined ? settingsPath : projectSettingsPath;
    for (const key of ["skills", "extensions", "tools", "extensionSettings"] as const) {
      if (consumerGlobal[key] === undefined && consumerProject[key] === undefined && sharedRoleSettings.effective[key] !== undefined) settingsSources = { ...settingsSources, [key]: sharedRoleSettings.sources[key] };
    }
    if (consumerGlobal.modelAliases === undefined && consumerProject.modelAliases === undefined) settingsSources = { ...settingsSources, modelAliases: sharedRoleSettings.sources.modelAliases ?? sharedRoleSettings.globalSettingsPath };
    // extensionSettings stay as resolved by resolveWorkflowSettings: the project consumer map replaces the global one.
    settings = { ...settings, modelAliases: composition.modelAliases };
    const canonical = (layer: typeof composition.selectorSources.global) => ({ ...layer, ...(layer.extensions === undefined ? {} : { extensions: layer.extensions.map(selector => canonicalExtensionSelector(selector, cwd)) }) });
    const sources = { ...composition.selectorSources, global: canonical(composition.selectorSources.global), project: canonical(composition.selectorSources.project), ...(composition.selectorSources.defaults ? { defaults: { global: canonical(composition.selectorSources.defaults.global), project: canonical(composition.selectorSources.defaults.project) } } : {}) };
    const all = [sources.defaults?.global, sources.defaults?.project, sources.global, sources.project];
    resourcePolicy = matchResourcePolicy({ ...policy, selectorSources: sources, effective: {
      skills: all.flatMap(layer => layer?.skills ?? []),
      extensions: all.flatMap(layer => layer?.extensions ?? []).map(selector => canonicalExtensionSelector(selector, cwd)),
      tools: all.flatMap(layer => layer?.tools ?? []),
    } }, pi);
    settings = { ...settings, skills: resourcePolicy.effective.skills, extensions: resourcePolicy.effective.extensions, tools: resourcePolicy.effective.tools ?? [] };
  } catch (error) {
    const message = errorText(error);
    const source = [roleProjectSettingsPath(cwd), roleSettingsPath(agentDir), projectSettingsPath].find(path => message.includes(path)) ?? settingsPath;
    if (!diagnostics.some(({ code, source: itemSource }) => code === "SETTINGS_INVALID" && itemSource === source)) diagnostics.push(diagnostic("error", "SETTINGS_INVALID", message, source, "Fix or remove the invalid workflow settings file."));
    resourcePolicy = emptyResourcePolicy(settingsPath, cwd, pi.trust.trusted);
  }
  for (const [source, selectors] of [[resourcePolicy.globalSettingsPath, resourcePolicy.selectorSources.global.tools], [resourcePolicy.projectSettingsPath, resourcePolicy.selectorSources.project.tools]] as const) {
    const toolSelectorDiagnostic = positiveOnlyToolSelectorDiagnostic(source, selectors);
    if (toolSelectorDiagnostic) diagnostics.push(toolSelectorDiagnostic);
  }
  for (const skill of resourcePolicy.unmatchedSkills) diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", `Skill selector currently matches no discovered skill: ${skill}`, `${resourcePolicySource(settingsSources.skills ?? settingsPath)}.skills`));
  for (const extension of resourcePolicy.unmatchedExtensions) diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", `Extension selector currently matches no discovered extension source: ${extension}`, `${resourcePolicySource(settingsSources.extensions ?? settingsPath)}.extensions`));
  for (const tool of resourcePolicy.unmatchedTools ?? []) diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", `Tool selector currently matches no root tool: ${tool}`, `${resourcePolicySource(settingsSources.tools ?? settingsPath)}.tools`));

  const activeTools = new Set(pi.activeTools);
  const knownModels = new Set(pi.knownModels);
  const availableModels = new Set(pi.availableModels);
  const aliases = settings.modelAliases ?? {};
  const registeredModelAliases = registry.modelAliases();
  const dynamicAliases = new Set(registeredModelAliases.map(({ name }) => name).filter((name) => !Object.prototype.hasOwnProperty.call(aliases, name)));
  const modelAliases: WorkflowCatalogModelAlias[] = [
    ...Object.keys(aliases).map((name) => ({ name, kind: "static" as const, provenance: Object.prototype.hasOwnProperty.call(consumerModelAliases, name) ? consumerAliasSource : sharedRoleSettings?.sources.modelAliases ?? settingsSources.modelAliases })),
    ...registeredModelAliases.map(({ name, version, headline }) => ({ name, kind: "dynamic" as const, provenance: `extension: ${headline}`, version, headline })),
  ].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  const roles: DoctorRole[] = [];
  const definitions = new Map<string, { path: string; definition: AgentDefinition }>();
  const duplicateExtensionNames = new Set<string>();
  // Keep this scan local because doctor reports every invalid and duplicate file; discoverRoles intentionally fails closed on the complete set.

  const fallbackDirectory = join(dirname(fileURLToPath(import.meta.resolve("@piewf/pi-ext-roles"))), "..", "starter", "roles");
  const sources: RoleDirectoryRegistration[] = [
    { path: fallbackDirectory, scope: "builtin", builtin: true },
    ...(pi.roleSources ?? []),
    ...legacyRoleSources(cwd, agentDir),
    ...roleDirectories(agentDir).map(path => ({ path, scope: "global" as const, priority: 100 })),
    { path: join(cwd, ".pi", "pi-ext-roles", "roles"), scope: "project", priority: 100 },
  ];
  const rank = { builtin: 0, extension: 1, global: 2, project: 3 };
  const seen = new Set<string>();
  const ordered = sources.filter(source => {
    const key = JSON.stringify([canonicalPath(source.path), source.owner, source.scope ?? "extension", source.priority ?? 0]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => rank[a.scope ?? "extension"] - rank[b.scope ?? "extension"] || (a.priority ?? 0) - (b.priority ?? 0) || a.path.localeCompare(b.path));
  const extensionNames = new Map<string, DoctorRole>();
  for (const source of ordered) {
    const scope = source.scope ?? "extension";
    let paths: string[];
    if (scope === "extension") {
      const metadata = source.extension ?? { headline: "Role contributor", version: "unknown" };
      const scan = scanExtensionRoleFiles([{ ...source, extension: metadata }]);
      for (const { registration, error } of scan.errors) diagnostics.push(diagnostic("error", "ROLE_DIRECTORY", `${extensionLabel(metadata)} role directory "${source.path}" could not be scanned: ${errorText(error)}`, registration.path, "Fix or remove the registered role directory."));
      for (const registration of scan.empty) diagnostics.push(diagnostic("warning", "ROLE_DIRECTORY_EMPTY", `${extensionLabel(metadata)} role directory "${source.path}" contains no .md role files`, registration.path));
      paths = scan.files.map(file => file.path);
    } else paths = roleFiles(source.path);
    for (const path of paths) {
      const name = basename(path, ".md");
      const active = scope !== "project" || pi.trust.trusted;
      const previous = [...roles].reverse().find(role => role.name === name && role.active);
      const role: DoctorRole = { name, path, provenance: source, scope: scope === "builtin" ? "extension" : scope, active, ...(source.extension ? { extension: source.extension } : {}), ...(active && previous ? { overrides: previous.path } : {}) };
      if (scope === "extension") {
        const duplicate = extensionNames.get(name);
        if (duplicate) { duplicateExtensionNames.add(name); diagnostics.push(diagnostic("error", "ROLE_DUPLICATE", `Duplicate extension role "${name}": ${duplicate.path}; ${path}`, path)); }
        extensionNames.set(name, role);
      }
      if (active && previous) { previous.active = false; previous.overriddenBy = path; }
      roles.push(role);
      // Untrusted project files are visible but never parsed or applied.
      if (!active) continue;
      const definition = parseRole(path, diagnostics, source.extension ? { directory: source.path, extension: source.extension } : undefined);
      if (scope === "extension" && duplicateExtensionNames.has(name)) { role.active = false; definitions.delete(name); continue; }
      if (definition) {
        definition.provenance = { path: canonicalPath(path), scope, ...(source.priority === undefined ? {} : { priority: source.priority }), ...(source.owner === undefined ? {} : { owner: source.owner }) };
        definitions.set(name, { path, definition });
      } else definitions.delete(name);
    }
  }
  for (const [name, { path, definition }] of definitions) {
    inspectRoleUsage(path, definition, activeTools, knownModels, availableModels, diagnostics, aliases, dynamicAliases, settingsPath);
    validateDoctorExtensionSettings(registry, mergeWorkflowExtensionSettings(settings.extensionSettings, definition.extensionSettings), "role", cwd, pi.trust.trusted, path, diagnostics, name);
  }
  const rolePaths = new Set(roles.map(({ path }) => path));
  if (diagnostics.some(({ code, source }) => source !== undefined && rolePaths.has(source) && (code === "ROLE_FRONTMATTER" || code === "AGENT_RESOURCE_SELECTOR_MIGRATION"))) diagnostics.push(diagnostic("error", "ROLE_LOAD_BLOCKED", "Workflow role loading is blocked because the runtime rejects the complete role set when any active role file is invalid.", undefined, "Fix the reported role file before launching workflows."));
  let roleInspection: DoctorRoleInspection | undefined;
  if (options.role !== undefined) {
    let target: { name: string; path: string; definition: AgentDefinition } | undefined;
    //NOTE: installed role names drop ".md", so a target ending in ".md" is a role file path.
    if (options.role.endsWith(".md")) {
      const path = resolve(cwd, options.role);
      if (!existsSync(path) || !statSync(path).isFile()) diagnostics.push(diagnostic("error", "ROLE_FILE_NOT_FOUND", `Role file not found: ${path}`, path));
      else {
        const name = basename(path, ".md");
        const found: DoctorDiagnostic[] = [];
        const definition = inspectRole(path, activeTools, knownModels, availableModels, found, aliases, dynamicAliases, settingsPath);
        if (definition) validateDoctorExtensionSettings(registry, mergeWorkflowExtensionSettings(settings.extensionSettings, definition.extensionSettings), "role", cwd, pi.trust.trusted, path, found, name);
        // Discovery already reported an installed file; add only what is new.
        const known = new Set(diagnostics.map((item) => JSON.stringify(item)));
        diagnostics.push(...found.filter((item) => !known.has(JSON.stringify(item))));
        if (definition) target = { name, path, definition };
      }
    } else {
      const effective = definitions.get(options.role);
      if (!effective) diagnostics.push(diagnostic("error", "ROLE_NOT_FOUND", `Active role not found: ${options.role}`, options.role));
      else target = { name: options.role, ...effective };
    }
    if (target) {
      const { name, path, definition } = target;
      const rootReference = pi.model ? `${pi.model.provider}/${pi.model.model}` : pi.availableModels[0] ?? pi.knownModels[0];
      if (!rootReference) diagnostics.push(diagnostic("error", "ROLE_INSPECTION_MODEL", "Cannot inspect a role because Pi has no registered model"));
      else {
        let rootModel: ReturnType<typeof resolveModelReference>;
        try {
          if (pi.model) { const thinking = parseThinking(pi.model.thinking); rootModel = { provider: pi.model.provider, model: pi.model.model, ...(thinking ? { thinking } : {}) }; } else rootModel = resolveModelReference(rootReference, aliases, knownModels, settingsPath);
          let roleAliases = aliases;
          if (definition.model && isDynamicModelAlias(definition.model, dynamicAliases)) {
            const dynamic = await registry.resolveModelAliases({ cwd, projectTrusted: pi.trust.trusted, rootModel, knownModels, availableModels, signal: new AbortController().signal });
            roleAliases = { ...aliases, ...dynamic };
          }
          roleInspection = await inspectRoleSession(cwd, agentDir, name, definition, path, resourcePolicy, rootModel, [...activeTools], roleAliases, knownModels, availableModels, settingsPath, settings.extensionSettings, options.prompt ?? "", registry.agentSetupHooks(), diagnostics);
          if (roleInspection) diagnostics.push(...roleInspection.setup.diagnostics);
        } catch (error) { diagnostics.push(diagnostic("error", "ROLE_INSPECTION_MODEL", errorText(error), path)); }
      }
    }
  }

  const functions: DoctorFunction[] = [];
  for (const [name, fn] of Object.entries(pi.functions).sort(([left], [right]) => left.localeCompare(right))) {
    functions.push({ name, description: fn.description, valid: true });
  }

  const severityOrder: Record<DoctorSeverity, number> = { error: 0, warning: 1 };
  diagnostics.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || (left.source ?? "").localeCompare(right.source ?? "") || left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  roles.sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope));
  return { cwd, agentDir, settingsPath, settings, settingsSources, ...(sharedRoleSettings ? { sharedRoleSettings } : {}), trust: pi.trust, activeTools: [...activeTools].sort(), piExtensions: [...new Set((pi.extensions ?? []).map(canonicalPath))].sort(), piSkills: [...new Set(pi.skills ?? [])].sort(), roles, functions, modelAliases, resourcePolicy, ...(options.role !== undefined ? { roleTarget: options.role } : {}), ...(roleInspection ? { roleInspection } : {}), diagnostics };
}

function count(report: DoctorReport, severity: DoctorSeverity): number { return report.diagnostics.filter((item) => item.severity === severity).length; }
export function doctorExitCode(report: DoctorReport): 0 | 1 { return count(report, "error") > 0 ? 1 : 0; }
function nestedValues(label: string, values: readonly string[]): string[] {
  return [`- ${label}:`, ...(values.length ? values.map((value) => `  - \`${value}\``) : ["  - (none)"])];
}
function roleSelectorSourceLines(sources: NonNullable<DoctorRoleInspection["resources"]["selectorSources"]>): string[] {
  return [
    ...(sources.defaults ? [...nestedValues("Shared global skill selectors", sources.defaults.global.skills ?? []), ...nestedValues("Shared project skill selectors", sources.defaults.project.skills ?? []), ...nestedValues("Shared global extension selectors", sources.defaults.global.extensions ?? []), ...nestedValues("Shared project extension selectors", sources.defaults.project.extensions ?? []), ...nestedValues("Shared global tool selectors", sources.defaults.global.tools ?? []), ...nestedValues("Shared project tool selectors", sources.defaults.project.tools ?? [])] : []),
    ...nestedValues("Global skill selectors", sources.global.skills ?? []),
    ...nestedValues("Global extension selectors", sources.global.extensions ?? []),
    ...nestedValues("Global tool selectors", sources.global.tools ?? []),
    ...nestedValues("Project skill selectors", sources.project.skills ?? []),
    ...nestedValues("Project extension selectors", sources.project.extensions ?? []),
    ...nestedValues("Project tool selectors", sources.project.tools ?? []),
    ...(sources.role === undefined ? [] : [
      ...nestedValues("Role skill selectors", sources.role.skills ?? []),
      ...nestedValues("Role extension selectors", sources.role.extensions ?? []),
      ...nestedValues("Role tool selectors", sources.role.tools ?? []),
    ]),
    ...(sources.call === undefined ? [] : [
      ...nestedValues("Call skill selectors", sources.call.skills ?? []),
      ...nestedValues("Call extension selectors", sources.call.extensions ?? []),
      ...nestedValues("Call tool selectors", sources.call.tools ?? []),
    ]),
  ];
}
function roleInspectionLines(inspection: DoctorRoleInspection): string[] {
  return [
    `- Role: \`${inspection.role}\` - \`${inspection.path}\``,
    `- Model: \`${inspection.model.provider}/${inspection.model.model}\` (${inspection.model.inherited ? "inherited, " : ""}${inspection.model.thinking ?? "off"})`,
    ...(inspection.resources.selectorSources ? roleSelectorSourceLines(inspection.resources.selectorSources) : []),
    ...nestedValues("Tools", inspection.tools),
    ...nestedValues("Configured skill selectors", inspection.resources.selectors.skills),
    ...nestedValues("Effective skills", inspection.resources.skills),
    ...nestedValues("Configured extension selectors", inspection.resources.selectors.extensions),
    ...nestedValues("Effective extensions", inspection.resources.extensions),
    ...nestedValues("Configured tool selectors", inspection.resources.selectors.tools),
    ...nestedValues("Effective tools", inspection.resources.tools),
    ...nestedValues("Unmatched skills", inspection.resources.unmatchedSkills),
    ...nestedValues("Unmatched extensions", inspection.resources.unmatchedExtensions),
    ...nestedValues("Unmatched tools", inspection.resources.unmatchedTools),
    `- Prompt probe: ${inspection.systemPrompt.probe ? JSON.stringify(inspection.systemPrompt.probe) : "empty"}`,
    `- Expanded probe: ${JSON.stringify(inspection.systemPrompt.expandedProbe)}`,
    `- System prompt source: ${inspection.systemPrompt.source ?? "(none)"}`,
    "### Final system prompt",
    "```",
    inspection.systemPrompt.text,
    "```",
    ...nestedValues("Applied setup hooks", inspection.setup.hooks),
    `- Setup diagnostics: ${String(inspection.setup.diagnostics.length)}`,
  ];
}

export function formatDoctorReport(report: DoctorReport): string {
  if (report.roleInspection || report.roleTarget !== undefined) {
    const lines = [
      "# pi-extensible-workflows doctor",
      "",
      "## Role inspection",
      ...(report.roleInspection ? roleInspectionLines(report.roleInspection) : [`- Role: \`${report.roleTarget ?? "(unknown)"}\``, "- Inspection unavailable"]),
      "",
      "## Diagnostics",
      ...(report.diagnostics.length ? report.diagnostics.map((item) => `- [${item.severity}] ${item.code}${item.source ? ` \`${item.source}\`` : ""}: ${item.message}${item.hint ? ` Fix: ${item.hint}` : ""}`) : ["- [ok] No diagnostics"]),
      "",
      "## Summary",
      `- ${String(count(report, "error"))} error(s), ${String(count(report, "warning"))} warning(s)`,
    ];
    return `${lines.join("\n")}\n`;
  }
  const roleLoadingFailed = report.diagnostics.some(({ code }) => code === "ROLE_LOAD_BLOCKED");
  const lines = [
    "# pi-extensible-workflows doctor",
    "",
    "## Environment",
    `- CWD: \`${report.cwd}\``,
    `- Agent dir: \`${report.agentDir}\``,
    `- Global workflow settings: \`${report.settingsPath}\``,
    `- Project workflow settings: \`${report.resourcePolicy.projectSettingsPath}\` (${report.resourcePolicy.projectTrusted ? "trusted" : "ignored: project untrusted"})`,
    `- Effective setting sources: concurrency=\`${report.settingsSources.concurrency}\`, modelAliases=\`${report.settingsSources.modelAliases}\`, skills=\`${report.settingsSources.skills ?? "(none)"}\`, extensions=\`${report.settingsSources.extensions ?? "(none)"}\`, extensionSettings=\`${report.settingsSources.extensionSettings ?? "(none)"}\`, tools=\`${report.settingsSources.tools ?? "(none)"}\``,
    `- Limits: concurrency=${String(report.settings.concurrency)}`,
    "",
    "## Trust/resources",
    `- [${report.trust.trusted ? "ok" : "warning"}] ${report.trust.source}`,
    "",
    "## Pi active tools",
    ...(report.activeTools.length ? report.activeTools.map((tool) => `- \`${tool}\``) : ["- None resolved"]),
    "",
    "## Pi active extensions",
    ...(report.piExtensions.length ? report.piExtensions.map((extension) => `- \`${extension}\``) : ["- None resolved"]),
    "",
    "## Pi active skills",
    ...(report.piSkills.length ? report.piSkills.map((skill) => `- \`${skill}\``) : ["- None resolved"]),
    "",
    ...(report.sharedRoleSettings ? [`- Shared global role settings: ${report.sharedRoleSettings.globalSettingsPath}`, `- Shared project role settings: ${report.sharedRoleSettings.projectSettingsPath}`, ...roleSelectorSourceLines(report.resourcePolicy.selectorSources)] : []),
    "## Workflow agent resource selectors",
    `- Global settings: \`${report.resourcePolicy.globalSettingsPath}\``,
    `- Global skills: ${report.resourcePolicy.global.skills.join(", ") || "(none)"}`,
    `- Global extensions: ${report.resourcePolicy.global.extensions.join(", ") || "(none)"}`,
    `- Global tools: ${(report.resourcePolicy.global.tools ?? []).join(", ") || "(none)"}`,
    `- Project settings: \`${report.resourcePolicy.projectSettingsPath}\` (${report.resourcePolicy.projectTrusted ? "trusted" : "ignored: project untrusted"})`,
    `- Project skills: ${report.resourcePolicy.project.skills.join(", ") || "(none)"}`,
    `- Project extensions: ${report.resourcePolicy.project.extensions.join(", ") || "(none)"}`,
    `- Project tools: ${(report.resourcePolicy.project.tools ?? []).join(", ") || "(none)"}`,
    `- Effective skills: ${(report.resourcePolicy.selectedSkills ?? []).join(", ") || "(none)"}`,
    `- Effective extensions: ${(report.resourcePolicy.selectedExtensions ?? []).join(", ") || "(none)"}`,
    `- Effective tools: ${(report.resourcePolicy.selectedTools ?? []).join(", ") || "(none)"}`,
    `- Unmatched skills: ${report.resourcePolicy.unmatchedSkills.join(", ") || "(none)"}`,
    `- Unmatched extensions: ${report.resourcePolicy.unmatchedExtensions.join(", ") || "(none)"}`,
    `- Unmatched tools: ${(report.resourcePolicy.unmatchedTools ?? []).join(", ") || "(none)"}`,
    "",
    "## Roles",
    ...(report.roles.length ? report.roles.map((role) => `- \`${role.name}\` (${role.scope}, ${role.active ? roleLoadingFailed ? "unavailable: role loading failed" : "active" : role.overriddenBy ? `overridden by ${role.overriddenBy}` : "inactive: project untrusted"}) - \`${role.path}\`${role.extension ? `; ${extensionLabel(role.extension)} role directory "${dirname(role.path)}"` : ""}${role.overrides ? `; overrides \`${role.overrides}\`` : ""}`) : ["- None found"]),
    "",
    "## Model aliases",
    ...(report.modelAliases.length ? report.modelAliases.map((alias) => `- [${alias.kind}] \`${alias.name}\`${alias.kind === "static" ? ` -> ${report.settings.modelAliases?.[alias.name] ?? "(unresolved)"}` : ""} (${alias.provenance})`) : ["- None registered"]),
    "",
    "## Reusable functions",
    ...(report.functions.length ? report.functions.map((fn) => `- [${fn.valid ? "ok" : "error"}] \`${fn.name}\` - ${fn.description}`) : ["- None registered"]),
    "",
    "## Diagnostics",
    ...(report.diagnostics.length ? report.diagnostics.map((item) => `- [${item.severity}] ${item.code}${item.source ? ` \`${item.source}\`` : ""}: ${item.message}${item.hint ? ` Fix: ${item.hint}` : ""}`) : ["- [ok] No diagnostics"]),
    "",
    "## Summary",
    `- ${String(count(report, "error"))} error(s), ${String(count(report, "warning"))} warning(s)`,
  ];
  return `${lines.join("\n")}\n`;
}
