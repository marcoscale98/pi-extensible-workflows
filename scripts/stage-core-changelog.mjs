import { copyFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "CHANGELOG.md");
const destination = resolve(root, "packages/core/CHANGELOG.md");
const action = process.argv[2];

if (action === "stage") copyFileSync(source, destination);
else if (action === "clean") rmSync(destination, { force: true });
else throw new Error("Expected stage or clean");
