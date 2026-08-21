import type { SubagentManager } from "../subagents/src/contracts.js";

let registeredSubagentManager: SubagentManager | undefined;

export function setSubagentManager(manager: SubagentManager | undefined): void { registeredSubagentManager = manager; }
export function getSubagentManager(): SubagentManager | undefined { return registeredSubagentManager; }
export function clearSubagentManager(manager: SubagentManager): void { if (registeredSubagentManager === manager) registeredSubagentManager = undefined; }
