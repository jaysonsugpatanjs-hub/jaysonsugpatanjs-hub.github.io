import test from "node:test";
import assert from "node:assert/strict";
import { expectedModuleAssets, moduleSlug, validateAuthoringManifest } from "../../supabase/functions/_shared/module-authoring.ts";

function sampleManifest() {
  return {
    slides: [
      {
        id: 1,
        title: "Introduction",
        bullets: ["First key point"],
        check: {
          question: "Choose the controlled action.",
          options: ["Incorrect", "Correct"],
          answer: 1,
          critical: true,
          feedback: "Correct feedback"
        }
      },
      {
        id: 2,
        title: "Summary",
        bullets: ["Complete the assessment"],
        check: "final"
      }
    ],
    exam: Array.from({ length: 5 }, (_, index) => ({
      question: `Question ${index + 1}`,
      options: ["Correct", "Incorrect"],
      answer: 0,
      critical: index === 0
    }))
  };
}

test("authoring validation strips correct answers from learner content", () => {
  const result = validateAuthoringManifest(sampleManifest());
  assert.equal(result.slideCount, 2);
  assert.equal(result.answerKey.checkpoints["1"].answer, 1);
  assert.equal(result.answerKey.exam.length, 5);
  assert.equal(JSON.stringify(result.learnerManifest).includes('"answer"'), false);
});

test("authoring validation rejects invalid answer indices", () => {
  const manifest = sampleManifest();
  manifest.slides[0].check.answer = 4;
  assert.throws(() => validateAuthoringManifest(manifest), /invalid correct-answer index/);
});

test("authoring validation requires the final slide marker", () => {
  const manifest = sampleManifest();
  manifest.slides[1].check = manifest.slides[0].check;
  assert.throws(() => validateAuthoringManifest(manifest), /last slide/);
});

test("module paths are canonical and complete", () => {
  assert.equal(moduleSlug("PP-TRN-WHS-002"), "pp-trn-whs-002");
  assert.deepEqual(expectedModuleAssets("pp-trn-whs-002/2026-09-29-v1", 2), [
    "pp-trn-whs-002/2026-09-29-v1/source.pptx",
    "pp-trn-whs-002/2026-09-29-v1/slide-01.webp",
    "pp-trn-whs-002/2026-09-29-v1/slide-02.webp"
  ]);
});
