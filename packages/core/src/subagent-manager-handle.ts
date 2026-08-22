import type { SubagentManager } from "../subagents/src/contracts.js";

const SUBAGENT_MANAGER_KEY = Symbol.for("pi-extensible-workflows.subagent-manager");
const globalSubagentManagers = globalThis as typeof globalThis & Record<symbol, SubagentManager | undefined>;

export function setSubagentManager(manager: SubagentManager | undefined): void { globalSubagentManagers[SUBAGENT_MANAGER_KEY] = manager; }
export function getSubagentManager(): SubagentManager | undefined { return globalSubagentManagers[SUBAGENT_MANAGER_KEY]; }
export function clearSubagentManager(manager: SubagentManager): void { if (globalSubagentManagers[SUBAGENT_MANAGER_KEY] === manager) globalSubagentManagers[SUBAGENT_MANAGER_KEY] = undefined; }
