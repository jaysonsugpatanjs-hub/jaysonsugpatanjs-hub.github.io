import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("../modules/pp-trn-wld-001/module.js", import.meta.url);
const moduleSource = await readFile(moduleUrl, "utf8");

test("async module actions retain the clicked button before awaiting", () => {
  const capturedButtons = moduleSource.match(/const button = event\.currentTarget;/g) || [];

  assert.equal(capturedButtons.length, 3);
  assert.doesNotMatch(moduleSource, /event\.currentTarget\.(?:disabled|textContent)/);
});
