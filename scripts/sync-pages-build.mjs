import { access, cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptsDirectory);
const distributionDirectory = join(repositoryRoot, "dist");
const publicDirectory = join(repositoryRoot, "public");

await access(join(distributionDirectory, "index.html"));

const rootAssets = join(repositoryRoot, "assets");
await rm(rootAssets, { recursive: true, force: true });
await cp(join(distributionDirectory, "assets"), rootAssets, { recursive: true });
await copyFile(join(distributionDirectory, "index.html"), join(repositoryRoot, "index.html"));

for (const entry of ["favicon.svg", ".nojekyll", "images", "downloads"]) {
  const source = join(publicDirectory, entry);
  const destination = join(repositoryRoot, entry);

  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

console.log("GitHub Pages production files are synchronized at the repository root.");
