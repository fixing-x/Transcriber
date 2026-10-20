import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const output = join(root, "_site");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const path of ["index.html", "service-worker.js", "styles/app.css", "src", "vendor/cactus", "docs/API.md", "docs/edge-cases.md", "licenses/NEEDLE-LICENSE", "licenses/WHISTLE-LICENSE"]) {
  const destination = join(output, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, path), destination, { recursive: true });
}

writeFileSync(join(output, ".nojekyll"), "");
console.log("GitHub Pages files copied to _site/.");
