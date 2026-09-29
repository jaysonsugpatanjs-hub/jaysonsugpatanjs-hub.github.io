export type AuthoringQuestion = {
  question: string;
  options: string[];
  answer: number;
  critical?: boolean;
  feedback?: string;
};

export type AuthoringSlide = {
  id: number;
  title: string;
  bullets: string[];
  check: AuthoringQuestion | "final";
};

export type AuthoringManifest = {
  slides: AuthoringSlide[];
  exam: AuthoringQuestion[];
};

export type ValidatedModuleContent = {
  slideCount: number;
  learnerManifest: {
    slides: Array<{
      id: number;
      title: string;
      bullets: string[];
      check: "final" | { question: string; options: string[]; critical: boolean };
    }>;
    exam: Array<{ question: string; options: string[]; critical: boolean }>;
  };
  answerKey: {
    checkpoints: Record<string, { answer: number; feedback: string; critical: boolean }>;
    exam: Array<{ answer: number; critical: boolean }>;
  };
};

function fail(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function text(value: unknown, label: string, maxLength: number) {
  const result = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!result) fail(`${label} is required.`);
  if (result.length > maxLength) fail(`${label} is too long.`);
  return result;
}

function cleanOptions(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) {
    fail(`${label} must contain between 2 and 5 answer options.`);
  }
  return value.map((option, index) => text(option, `${label} option ${index + 1}`, 500));
}

function cleanQuestion(value: unknown, label: string, feedbackRequired: boolean): AuthoringQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is incomplete.`);
  const input = value as Record<string, unknown>;
  const options = cleanOptions(input.options, label);
  const answer = Number(input.answer);
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    fail(`${label} has an invalid correct-answer index.`);
  }
  const result: AuthoringQuestion = {
    question: text(input.question, `${label} question`, 800),
    options,
    answer,
    critical: Boolean(input.critical)
  };
  const feedback = String(input.feedback ?? "").trim().replace(/\s+/g, " ");
  if (feedbackRequired && !feedback) fail(`${label} requires feedback for a correct answer.`);
  if (feedback.length > 1000) fail(`${label} feedback is too long.`);
  if (feedback) result.feedback = feedback;
  return result;
}

export function moduleSlug(code: unknown) {
  const value = String(code ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!value || value.length > 80) fail("Module code cannot be converted to a valid URL slug.");
  return value;
}

export function validateAuthoringManifest(value: unknown): ValidatedModuleContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("The authoring JSON must contain a module object.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.slides) || input.slides.length < 2 || input.slides.length > 200) {
    fail("The authoring JSON must contain between 2 and 200 slides.");
  }
  if (!Array.isArray(input.exam) || input.exam.length < 5 || input.exam.length > 50) {
    fail("The final assessment must contain between 5 and 50 questions.");
  }

  const finalIndex = input.slides.length - 1;
  const slides = input.slides.map((rawSlide, index) => {
    if (!rawSlide || typeof rawSlide !== "object" || Array.isArray(rawSlide)) fail(`Slide ${index + 1} is incomplete.`);
    const slide = rawSlide as Record<string, unknown>;
    if (Number(slide.id) !== index + 1) fail(`Slide ${index + 1} is missing or out of order.`);
    if (!Array.isArray(slide.bullets) || slide.bullets.length < 1 || slide.bullets.length > 12) {
      fail(`Slide ${index + 1} must contain between 1 and 12 key points.`);
    }
    const cleaned: AuthoringSlide = {
      id: index + 1,
      title: text(slide.title, `Slide ${index + 1} title`, 200),
      bullets: slide.bullets.map((bullet, bulletIndex) => text(bullet, `Slide ${index + 1} key point ${bulletIndex + 1}`, 700)),
      check: "final"
    };
    if (index === finalIndex) {
      if (slide.check !== "final") fail("The last slide must use the final assessment.");
    } else {
      cleaned.check = cleanQuestion(slide.check, `Slide ${index + 1} knowledge check`, true);
    }
    return cleaned;
  });

  const exam = input.exam.map((question, index) => cleanQuestion(question, `Final assessment question ${index + 1}`, false));
  const learnerManifest = {
    slides: slides.map(slide => ({
      id: slide.id,
      title: slide.title,
      bullets: slide.bullets,
      check: slide.check === "final" ? "final" as const : {
        question: slide.check.question,
        options: slide.check.options,
        critical: Boolean(slide.check.critical)
      }
    })),
    exam: exam.map(question => ({
      question: question.question,
      options: question.options,
      critical: Boolean(question.critical)
    }))
  };
  const answerKey = {
    checkpoints: Object.fromEntries(slides.slice(0, -1).map(slide => {
      const check = slide.check as AuthoringQuestion;
      return [String(slide.id), {
        answer: check.answer,
        feedback: check.feedback || "Your answer has been recorded.",
        critical: Boolean(check.critical)
      }];
    })),
    exam: exam.map(question => ({ answer: question.answer, critical: Boolean(question.critical) }))
  };

  if (/"answer"\s*:/.test(JSON.stringify(learnerManifest))) fail("The learner content unexpectedly contains an answer key.");
  return { slideCount: slides.length, learnerManifest, answerKey };
}

export function expectedModuleAssets(storagePrefix: string, slideCount: number) {
  return [
    `${storagePrefix}/source.pptx`,
    ...Array.from({ length: slideCount }, (_, index) => `${storagePrefix}/slide-${String(index + 1).padStart(2, "0")}.webp`)
  ];
}
