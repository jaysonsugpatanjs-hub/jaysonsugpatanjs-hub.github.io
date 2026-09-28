const DECK = "../../ppt/pp-trn-wld-001/";
const STORAGE_KEY = "panalo-pp-trn-wld-001-v4";
const el = {
  landing: document.getElementById("landing"),
  lesson: document.getElementById("lesson"),
  assessment: document.getElementById("assessment"),
  nav: document.getElementById("nav"),
  start: document.getElementById("start"),
  reset: document.getElementById("reset")
};
let course;
let state = readState();

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.passed)) return saved;
  } catch (_) { /* Storage may be disabled. The module still works for this visit. */ }
  return { passed: [], current: 0, final: null, attempts: 0, revision: null };
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* See note above. */ }
  renderNav();
  renderProgress();
}
function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
function slideURL(number) { return `${DECK}slide-${String(number).padStart(2, "0")}.webp?v=${encodeURIComponent(course.slideAssetVersion || course.contentVersion || course.revision)}`; }
function isComplete(index) { return state.passed.includes(index); }
function canOpen(index) { return index === 0 || isComplete(index - 1); }
function show(view) {
  for (const name of ["landing", "lesson", "assessment"]) el[name].classList.toggle("hidden", view !== name);
  renderNav();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderProgress() {
  const complete = state.passed.length + (state.final?.pass ? 1 : 0);
  const total = course.slides.length;
  const percent = Math.round(complete / total * 100);
  document.getElementById("pct").textContent = `${percent}%`;
  document.getElementById("bar").style.width = `${percent}%`;
  document.getElementById("progress-detail").textContent = state.final?.pass
    ? "Theory passed · practical pending"
    : `${state.passed.length} of ${total - 1} slide checks complete`;
}
function renderNav() {
  if (!course) return;
  el.nav.replaceChildren();
  const finalIndex = course.slides.length - 1;
  course.slides.forEach((slide, index) => {
    const button = document.createElement("button");
    const available = canOpen(index);
    button.disabled = !available;
    button.classList.toggle("active", index === finalIndex ? !el.assessment.classList.contains("hidden") :
      !el.lesson.classList.contains("hidden") && state.current === index);
    button.setAttribute("aria-label", `Slide ${slide.id}: ${slide.title}${available ? "" : ", locked"}`);
    button.innerHTML = `<span class="navnum">${slide.id}</span><span>${safe(slide.title)}</span><span class="navstatus" aria-hidden="true">${index === finalIndex ? (state.final?.pass ? "✓" : available ? "" : "🔒") : isComplete(index) ? "✓" : available ? "" : "🔒"}</span>`;
    button.addEventListener("click", () => index === finalIndex ? showAssessment() : showSlide(index));
    el.nav.appendChild(button);
  });
}
function slideMarkup(slide) {
  const filename = slideURL(slide.id);
  return `<div class="slidehead"><div><p class="eyebrow">POWERPOINT SLIDE ${slide.id} OF ${course.slides.length}</p><h1>${safe(slide.title)}</h1></div><span class="slidepill">${slide.check?.critical ? "CRITICAL CHECK" : "TRAINING"}</span></div>
    <div class="slidevisual"><div class="image-status" id="image-status" role="status">Loading slide ${slide.id}…</div><img id="slide-image" alt="PowerPoint slide ${slide.id}: ${safe(slide.title)}" width="1921" height="1080"><a href="${filename}" target="_blank" rel="noopener" class="fullsize">Open this slide at full size ↗</a></div>
    <section class="contentcard transcript"><h2>Key points</h2><ul>${slide.bullets.map(point => `<li>${safe(point)}</li>`).join("")}</ul></section>`;
}
function loadSlideImage(container, number) {
  const image = container.querySelector("#slide-image");
  const status = container.querySelector("#image-status");
  image.addEventListener("load", () => { status.remove(); image.classList.add("ready"); }, { once: true });
  image.addEventListener("error", () => { status.textContent = "The slide image could not load. Use the source PowerPoint link below and report the problem."; }, { once: true });
  // Only the selected slide receives an src. The library and other slides load no deck images.
  image.src = slideURL(number);
}
function markPassed(index) {
  if (!isComplete(index)) state.passed.push(index);
  state.passed.sort((a, b) => a - b);
  persist();
}

function showSlide(index) {
  if (!canOpen(index) || index >= course.slides.length - 1) return;
  state.current = index;
  const slide = course.slides[index];
  const done = isComplete(index);
  const q = slide.check;
  el.lesson.innerHTML = slideMarkup(slide) +
    `<section class="checkpoint" aria-labelledby="check-title"><span class="slidepill ${q.critical ? "critical" : ""}">${q.critical ? "CRITICAL CHECKPOINT" : "KNOWLEDGE CHECK"}</span><h2 id="check-title">Check your decision</h2><p class="q">${safe(q.question)}</p>
      <fieldset><legend class="sr-only">Choose one answer</legend>${q.options.map((option, optionIndex) => `<label class="option"><input type="radio" name="checkpoint" value="${optionIndex}" ${done && q.answer === optionIndex ? "checked" : ""}> <span>${safe(option)}</span></label>`).join("")}</fieldset>
      <button class="primary" id="check-answer">Check answer</button><div id="checkpoint-feedback" role="status" aria-live="polite">${done ? `<div class="feedback ok">Completed. ${safe(q.feedback)}</div>` : ""}</div></section>
      <div class="actions"><button class="secondary" id="previous" ${index === 0 ? "disabled" : ""}>Previous slide</button><button class="primary" id="next" ${done ? "" : "disabled"}>${index === course.slides.length - 2 ? "Final assessment" : "Next slide"}</button></div>`;
  show("lesson");
  loadSlideImage(el.lesson, slide.id);
  el.lesson.querySelector("#previous").addEventListener("click", () => showSlide(index - 1));
  el.lesson.querySelector("#next").addEventListener("click", () => index === course.slides.length - 2 ? showAssessment() : showSlide(index + 1));
  el.lesson.querySelector("#check-answer").addEventListener("click", () => {
    const selected = el.lesson.querySelector('input[name="checkpoint"]:checked');
    const feedback = el.lesson.querySelector("#checkpoint-feedback");
    if (!selected) { feedback.innerHTML = '<div class="feedback no">Choose an answer first.</div>'; return; }
    if (Number(selected.value) !== q.answer) {
      feedback.innerHTML = '<div class="feedback no">Review the slide and the key points, then try again.</div>';
      return;
    }
    feedback.innerHTML = `<div class="feedback ok">Correct. ${safe(q.feedback)}</div>`;
    markPassed(index);
    el.lesson.querySelector("#next").disabled = false;
  });
  persist();
}

function showAssessment() {
  const finalIndex = course.slides.length - 1;
  if (!canOpen(finalIndex)) return;
  const slide = course.slides[finalIndex];
  const prior = state.final;
  el.assessment.innerHTML = slideMarkup(slide) +
    `<section class="checkpoint" aria-labelledby="exam-title"><span class="slidepill critical">FINAL THEORY ASSESSMENT</span><h2 id="exam-title">Apply what you learned</h2><p>Pass rule: at least 80% overall and every critical question correct. An online pass leaves practical verification pending.</p>
      ${course.exam.map((q, index) => `<fieldset class="examq ${q.critical ? "critical" : ""}"><legend>Q${index + 1}. ${safe(q.question)} ${q.critical ? '<span class="badge">CRITICAL</span>' : ""}</legend>${q.options.map((option, optionIndex) => `<label class="option"><input type="radio" name="exam-${index}" value="${optionIndex}" ${prior?.answers?.[index] === optionIndex ? "checked" : ""}> <span>${safe(option)}</span></label>`).join("")}</fieldset>`).join("")}
      <button class="primary large" id="submit-exam">${prior ? "Submit another attempt" : "Submit final assessment"}</button><div id="result" role="status" aria-live="polite"></div></section>
      <div class="actions"><button class="secondary" id="back-slide">Back to slide ${finalIndex}</button></div>`;
  show("assessment");
  loadSlideImage(el.assessment, slide.id);
  el.assessment.querySelector("#back-slide").addEventListener("click", () => showSlide(finalIndex - 1));
  el.assessment.querySelector("#submit-exam").addEventListener("click", grade);
  if (prior) renderResult(prior);
}
function grade() {
  const answers = course.exam.map((_, index) => {
    const selected = el.assessment.querySelector(`input[name="exam-${index}"]:checked`);
    return selected ? Number(selected.value) : null;
  });
  const firstMissing = answers.indexOf(null);
  if (firstMissing >= 0) {
    el.assessment.querySelector("#result").innerHTML = `<div class="feedback no">Answer all questions before submitting. Question ${firstMissing + 1} is incomplete.</div>`;
    el.assessment.querySelectorAll(".examq")[firstMissing].scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const missed = course.exam.flatMap((q, index) => answers[index] === q.answer ? [] : [index + 1]);
  const correct = course.exam.length - missed.length;
  const critical = course.exam.every((q, index) => !q.critical || answers[index] === q.answer);
  const pass = correct / course.exam.length >= 0.8 && critical;
  state.attempts = (state.attempts || 0) + 1;
  state.final = { answers, correct, score: Math.round(correct / course.exam.length * 100), critical, pass, missed, attempt: state.attempts, date: new Date().toISOString(), revision: course.revision };
  persist();
  renderResult(state.final);
}
function renderResult(result) {
  const target = el.assessment.querySelector("#result");
  const date = new Date(result.date).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
  target.innerHTML = `<div class="result ${result.pass ? "pass" : "fail"}"><h2>${result.pass ? "THEORY PASSED · PRACTICAL PENDING" : "FURTHER TRAINING REQUIRED"}</h2>
    <p><strong>Score:</strong> ${result.correct}/${course.exam.length} (${result.score}%) · <strong>Critical questions:</strong> ${result.critical ? "PASS" : "NOT PASSED"} · <strong>Attempt:</strong> ${result.attempt} · ${safe(date)}</p>
    <p>${result.pass ? "A competent assessor must observe the task and confirm site requirements before authorisation." : `Review the lesson and retake the assessment. Questions to revisit: ${result.missed.join(", ")}.`}</p>
    <p class="record-note">Pilot result saved on this browser. Download a copy for IMS administration. The download is provisional and does not replace a controlled training record.</p>
    <label for="worker-id">Employee ID for downloaded copy (optional; not saved on this site)</label><input type="text" id="worker-id" maxlength="80" autocomplete="off" placeholder="Employee ID">
    <div class="result-actions"><button class="secondary" id="download-result">Download provisional result</button>${result.pass ? '<a class="secondary link-button" href="./practical-checklist.html" target="_blank" rel="noopener">Open practical checklist</a>' : ""}</div></div>`;
  target.querySelector("#download-result").addEventListener("click", () => downloadResult(result));
}
function downloadResult(result) {
  const employeeId = el.assessment.querySelector("#worker-id").value.trim();
  const record = {
    status: "PROVISIONAL THEORY RESULT — NOT PRACTICAL AUTHORISATION",
    module: course.code, revision: course.revision, contentVersion: course.contentVersion, employeeId,
    score: result.score, correct: result.correct, total: course.exam.length,
    criticalPassed: result.critical, theoryPassed: result.pass,
    practicalStatus: "PENDING", attempt: result.attempt, submittedAt: result.date,
    missedQuestionNumbers: result.missed
  };
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${course.code}-theory-result-${result.date.slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init() {
  el.start.disabled = true;
  el.start.textContent = "Loading module…";
  try {
    const response = await fetch(`${DECK}manifest.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Module manifest returned ${response.status}`);
    course = await response.json();
    const finalIndex = course.slides?.length - 1;
    if (finalIndex < 1 || course.slides.some((slide, index) => slide.id !== index + 1 || (index < finalIndex && (!slide.check || !Array.isArray(slide.check.options)))) || course.slides[finalIndex].check !== "final" || !Array.isArray(course.exam) || !course.exam.length) {
      throw new Error("The module is missing a slide or knowledge check");
    }
    const version = course.contentVersion || course.revision;
    if (state.revision !== version) {
      state = { passed: [], current: 0, final: null, attempts: 0, revision: version };
    }
    state.revision = version;
    state.passed = [...new Set(state.passed.filter(index => Number.isInteger(index) && index >= 0 && index < finalIndex))];
    state.current = Math.max(0, Math.min(finalIndex - 1, Number(state.current) || 0));
    el.start.disabled = false;
    el.start.textContent = "Start / Continue Training";
    el.start.addEventListener("click", () => showSlide(canOpen(state.current) ? state.current : 0));
    el.reset.addEventListener("click", () => {
      if (window.confirm("Reset this module's progress and theory result on this browser?")) {
        localStorage.removeItem(STORAGE_KEY);
        state = { passed: [], current: 0, final: null, attempts: 0, revision: version };
        show("landing"); persist();
      }
    });
    persist();
  } catch (error) {
    el.start.textContent = "Module unavailable";
    document.getElementById("load-error").textContent = `The training content could not load: ${error.message}. Contact the module administrator.`;
  }
}
init();
