/**
 * setup-electron.mjs
 *
 * Prepares the dist-electron/ directory for Electron backend compilation.
 *
 * 1. Removes dist-electron/ if it exists (clean build).
 * 2. Creates dist-electron/ directory.
 * 3. Writes dist-electron/package.json with { "type": "commonjs" }.
 *
 * The package.json overrides the root "type": "module" so that all compiled
 * backend files under dist-electron/ are treated as CommonJS by Node.js.
 * This is necessary because Electron main process requires CommonJS format.
 *
 * Must be run before `tsc -p tsconfig.electron.json`.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const outDir = "dist-electron";

// Clean existing output for a fresh build
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
  console.log(`✓ Cleaned ${outDir}/`);
}

mkdirSync(outDir, { recursive: true });

// Mark compiled output as CommonJS so Node.js and Electron load it correctly
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);

console.log(`✓ dist-electron/package.json created (type: commonjs)`);
