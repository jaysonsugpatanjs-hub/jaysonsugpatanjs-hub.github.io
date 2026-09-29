export function endOfSydneyDayIso(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ""))) throw new Error("Choose a valid expiry date.");
  const [year, month, day] = dateString.split("-").map(Number);
  const targetWallClockUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  let instant = targetWallClockUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 999);
    instant -= representedAsUtc - targetWallClockUtc;
  }
  return new Date(instant).toISOString();
}

export function defaultContentVersion(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}-v1`;
}

export function sortSlideFiles(fileList) {
  return [...fileList].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function moduleAuthoringTemplate() {
  return {
    slides: [
      {
        id: 1,
        title: "Module introduction",
        bullets: [
          "State the purpose of this training module.",
          "Explain the first important control or expected behaviour.",
          "Keep the wording aligned with the approved IMS documents."
        ],
        check: {
          question: "Which action best applies the controls introduced on this slide?",
          options: ["Unsafe or incorrect option", "Correct controlled action", "Another incorrect option"],
          answer: 1,
          critical: false,
          feedback: "Correct. Apply the approved control before continuing."
        }
      },
      {
        id: 2,
        title: "Critical control",
        bullets: [
          "Describe the critical risk and required control.",
          "Explain the stop-work trigger.",
          "Identify who must authorise the work."
        ],
        check: {
          question: "What should happen if the critical control is missing?",
          options: ["Continue carefully", "Stop, make safe and obtain the required control and authorisation", "Complete the paperwork later"],
          answer: 1,
          critical: true,
          feedback: "Correct. A missing critical control is a stop-work condition."
        }
      },
      {
        id: 3,
        title: "Summary and final assessment",
        bullets: [
          "Summarise the key controls.",
          "Remind learners that theory does not replace practical verification.",
          "Complete the final theory assessment below."
        ],
        check: "final"
      }
    ],
    exam: [
      { question: "Sample final question 1?", options: ["Incorrect", "Correct", "Incorrect"], answer: 1, critical: true },
      { question: "Sample final question 2?", options: ["Correct", "Incorrect", "Incorrect"], answer: 0, critical: false },
      { question: "Sample final question 3?", options: ["Incorrect", "Incorrect", "Correct"], answer: 2, critical: false },
      { question: "Sample final question 4?", options: ["Incorrect", "Correct", "Incorrect"], answer: 1, critical: true },
      { question: "Sample final question 5?", options: ["Correct", "Incorrect", "Incorrect"], answer: 0, critical: false }
    ]
  };
}
