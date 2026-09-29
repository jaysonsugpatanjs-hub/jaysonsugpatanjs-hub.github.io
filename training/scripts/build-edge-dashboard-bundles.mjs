import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const functionsRoot = path.join(root, "supabase/functions");
const outputRoot = path.join(root, "tmp/edge-bundles");

async function source(relativePath) {
  return readFile(path.join(functionsRoot, relativePath), "utf8");
}

function withoutImports(code) {
  return code.replace(/^import .*?;\n/gm, "");
}

function withoutSharedImports(code) {
  return code.replace(/^import .*?from "\.\.\/_shared\/.*?";\n/gm, "");
}

function localiseExports(code) {
  return code
    .replace(/^export type /gm, "type ")
    .replace(/^export function /gm, "function ")
    .replace(/^export async function /gm, "async function ")
    .replace(/^export const /gm, "const ");
}

async function buildTrainingApi() {
  const entry = await source("training-api/index.ts");
  const http = localiseExports(withoutImports(await source("_shared/http.ts")));
  const grading = localiseExports(withoutImports(await source("_shared/grading.ts")));
  const certificateSource = await source("_shared/certificate.ts");
  const certificateImport = certificateSource.match(/^import .*?;$/m)?.[0] || "";
  const certificate = localiseExports(withoutImports(certificateSource));
  const entryImport = entry.match(/^import \{ withSupabase \}.*?;$/m)?.[0] || "";
  const entryBody = withoutSharedImports(entry).replace(/^import \{ withSupabase \}.*?;\n/m, "");
  return `${entryImport}\n${certificateImport}\n\n${http}\n${grading}\n${certificate}\n${entryBody}`;
}

async function buildAdminApi() {
  const entry = await source("admin-api/index.ts");
  const http = localiseExports(withoutImports(await source("_shared/http.ts")));
  const entryImport = entry.match(/^import \{ withSupabase \}.*?;$/m)?.[0] || "";
  const entryBody = withoutSharedImports(entry).replace(/^import \{ withSupabase \}.*?;\n/m, "");
  return `${entryImport}\n\n${http}\n${entryBody}`;
}

await mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeFile(path.join(outputRoot, "training-api.ts"), await buildTrainingApi()),
  writeFile(path.join(outputRoot, "admin-api.ts"), await buildAdminApi())
]);

console.log(outputRoot);
