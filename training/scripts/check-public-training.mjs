#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("training");
const forbiddenExtensions = new Set([".ppt", ".pptx"]);
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      if (relative === "ppt" || relative.startsWith("private")) findings.push(`${relative}/ must not be published`);
      else await walk(absolute);
      continue;
    }
    if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) findings.push(`${relative} is a PowerPoint source file`);
    if (/manifest\.json$/i.test(entry.name)) {
      const text = await readFile(absolute, "utf8");
      if (/"answer"\s*:/.test(text)) findings.push(`${relative} contains assessment answers`);
    }
  }
}

await walk(root);
if (findings.length) {
  console.error("Public training security check failed:\n- " + findings.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("Public training security check passed: no PowerPoint source or answer-bearing manifest is deployable.");
}
