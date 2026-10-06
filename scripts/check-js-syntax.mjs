// Fails if any browser JavaScript file under the given folders has a syntax
// error (the no-build pages ship their source as-is).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(m?js)$/.test(name)) files.push(path);
  }
};
for (const dir of process.argv.slice(2)) walk(dir);
let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); }
  catch (error) { failed++; console.error(`Syntax error in ${file}\n${error.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} JavaScript files parse.`);
process.exit(failed ? 1 : 0);
