import test from "node:test";
import assert from "node:assert/strict";
import { allLearningSlidesComplete, gradeAssessment, isSlideUnlocked } from "../../supabase/functions/_shared/grading.ts";

const key = [
  { answer: 1 },
  { answer: 0, critical: true },
  { answer: 2 },
  { answer: 1, critical: true },
  { answer: 0 }
];

test("passing requires the overall mark and every critical answer", () => {
  const passed = gradeAssessment([1, 0, 2, 1, 2], key, 80);
  assert.equal(passed.score, 80);
  assert.equal(passed.criticalPassed, true);
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.missedQuestionNumbers, [5]);

  const criticalMiss = gradeAssessment([1, 2, 2, 1, 0], key, 80);
  assert.equal(criticalMiss.score, 80);
  assert.equal(criticalMiss.criticalPassed, false);
  assert.equal(criticalMiss.passed, false);
  assert.deepEqual(criticalMiss.missedQuestionNumbers, [2]);
});

test("a high score below the configured threshold does not pass", () => {
  const result = gradeAssessment([1, 0, 2, 1, 2], key, 90);
  assert.equal(result.score, 80);
  assert.equal(result.passed, false);
});

test("slide access remains sequential", () => {
  const completed = new Set([1, 2]);
  assert.equal(isSlideUnlocked(1, 20, completed), true);
  assert.equal(isSlideUnlocked(3, 20, completed), true);
  assert.equal(isSlideUnlocked(4, 20, completed), false);
  assert.equal(allLearningSlidesComplete(4, completed), false);
  completed.add(3);
  assert.equal(allLearningSlidesComplete(4, completed), true);
});

test("invalid answer arrays are rejected", () => {
  assert.throws(() => gradeAssessment([1], key, 80), /do not match/);
  assert.throws(() => gradeAssessment([1, -1, 2, 1, 0], key, 80), /invalid/);
});
