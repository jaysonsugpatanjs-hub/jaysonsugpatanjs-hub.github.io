export type AnswerKeyItem = { answer: number; critical?: boolean };

export function gradeAssessment(answers: number[], key: AnswerKeyItem[], passMark: number) {
  if (!Array.isArray(answers) || !Array.isArray(key) || key.length < 1 || answers.length !== key.length) {
    throw new Error("Assessment answers do not match the answer key.");
  }
  if (!answers.every(value => Number.isInteger(value) && value >= 0)) throw new Error("Assessment answers are invalid.");
  if (!key.every(question => Number.isInteger(Number(question.answer)) && Number(question.answer) >= 0)) throw new Error("Assessment answer key is invalid.");

  const missedQuestionNumbers: number[] = [];
  let correctCount = 0;
  let criticalPassed = true;
  key.forEach((question, index) => {
    if (answers[index] === Number(question.answer)) correctCount += 1;
    else {
      missedQuestionNumbers.push(index + 1);
      if (question.critical) criticalPassed = false;
    }
  });
  const score = Math.round(correctCount / key.length * 100);
  return {
    correctCount,
    totalQuestions: key.length,
    score,
    criticalPassed,
    passed: score >= passMark && criticalPassed,
    missedQuestionNumbers
  };
}

export function isSlideUnlocked(slideNumber: number, slideCount: number, completedSlides: Set<number>) {
  if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > slideCount) return false;
  return slideNumber === 1 || completedSlides.has(slideNumber - 1);
}

export function allLearningSlidesComplete(slideCount: number, completedSlides: Set<number>) {
  for (let slide = 1; slide < slideCount; slide += 1) if (!completedSlides.has(slide)) return false;
  return true;
}
