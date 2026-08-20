import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "CHANGELOG.md");
const destination = resolve(root, "packages/core/CHANGELOG.md");
const marker = resolve(root, ".tmp", "core-changelog-staged");
const action = process.argv[2];

function stage() {
  if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "");
    copyFileSync(source, destination);
  } catch (error) {
    rmSync(destination, { force: true });
    rmSync(marker, { force: true });
    throw error;
  }
}

function clean() {
  if (!existsSync(marker)) return;
  rmSync(destination, { force: true });
  rmSync(marker, { force: true });
}

if (action === "stage") stage();
else if (action === "clean") clean();
else throw new Error("Expected stage or clean");
