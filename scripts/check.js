import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set([".git", "node_modules", "_site"]);

function collectJavaScript(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) files.push(...collectJavaScript(join(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) files.push(join(directory, entry.name));
  }
  return files;
}

const files = collectJavaScript(root);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax check failed: ${relative(root, file)}`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`Syntax checked ${files.length} JavaScript files.`);
