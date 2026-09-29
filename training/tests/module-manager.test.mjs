import test from "node:test";
import assert from "node:assert/strict";
import { defaultContentVersion, endOfSydneyDayIso, moduleAuthoringTemplate, sortSlideFiles } from "../admin/module-manager-core.js";

test("assignment expiry uses the end of the selected Sydney day", () => {
  assert.equal(endOfSydneyDayIso("2026-09-30"), "2026-09-30T13:59:59.999Z");
  assert.equal(endOfSydneyDayIso("2026-12-01"), "2026-12-01T12:59:59.999Z");
});

test("content versions use the Sydney calendar date", () => {
  assert.equal(defaultContentVersion(new Date("2026-09-28T15:00:00Z")), "2026-09-29-v1");
});

test("rendered slide files sort naturally by filename", () => {
  const files = [{ name: "Slide10.png" }, { name: "Slide2.png" }, { name: "Slide1.png" }];
  assert.deepEqual(sortSlideFiles(files).map(file => file.name), ["Slide1.png", "Slide2.png", "Slide10.png"]);
});

test("downloadable template contains a final slide and assessment", () => {
  const template = moduleAuthoringTemplate();
  assert.equal(template.slides.at(-1).check, "final");
  assert.equal(template.exam.length, 5);
});
