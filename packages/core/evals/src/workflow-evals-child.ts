import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureEvalCase, type CaptureCaseInput, validateWorkflowEvalCases } from "./workflow-evals.js";
import { isObject } from "../../src/utils.js";

interface ChildInput { payload: CaptureCaseInput; outputPath: string }

function isCaptureCaseInput(value: unknown): value is CaptureCaseInput {
  if (!isObject(value) || typeof value.model !== "string" || typeof value.maxCost !== "number" || !Number.isFinite(value.maxCost) || [value.provider, value.thinking, value.piCommand].some((item) => item !== undefined && typeof item !== "string")) return false;
  try { validateWorkflowEvalCases([value.case], "eval child input"); return true; } catch { return false; }
}

function readChildInput(value: unknown): ChildInput {
  if (!isObject(value) || !isCaptureCaseInput(value.payload)) throw new Error("Invalid eval child payload");
  if (typeof value.outputPath !== "string" || !value.outputPath.trim()) throw new Error("Invalid eval child output path");
  return { payload: value.payload, outputPath: value.outputPath };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Missing eval child input path");
  const parsed: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
  const input = readChildInput(parsed);
  const result = await captureEvalCase(input.payload);
  writeFileSync(input.outputPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });