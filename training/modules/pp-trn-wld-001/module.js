import {
  api,
  completeAuthRedirect,
  config,
  friendlyError,
  getSession,
  isConfigured,
  signOut
} from "../../auth.js";

const assignmentId = new URLSearchParams(window.location.search).get("assignment");
const ui = {
  shell: document.getElementById("module-shell"),
  gate: document.getElementById("gate"),
  gateTitle: document.getElementById("gate-title"),
  gateMessage: document.getElementById("gate-message"),
  gateAction: document.getElementById("gate-action"),
  landing: document.getElementById("landing"),
  lesson: document.getElementById("lesson"),
  assessment: document.getElementById("assessment"),
  nav: document.getElementById("nav"),
  start: document.getElementById("start")
};

let assignment;
let course;
let learner;
let latestResult = null;
let completedSlides = new Set();
let currentIndex = 0;
const slideUrls = new Map();
const preloadedSlides = new Set();

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value, withTime = false) {
  if (!value) return "No expiry set";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
    timeZone: "Australia/Sydney"
  }).format(new Date(value));
}

function showGate(title, message) {
  ui.shell.classList.add("hidden");
  ui.gate.classList.remove("hidden");
  ui.gateTitle.textContent = title;
  ui.gateMessage.textContent = message;
  ui.gateAction.classList.remove("hidden");
}

function show(view) {
  ui.gate.classList.add("hidden");
  ui.shell.classList.remove("hidden");
  for (const name of ["landing", "lesson", "assessment"]) ui[name].classList.toggle("hidden", view !== name);
  renderNav();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function isComplete(slideNumber) {
  return completedSlides.has(slideNumber);
}

function canOpen(index) {
  return index === 0 || isComplete(index);
}

function renderProgress() {
  const learningSlides = course.slides.length - 1;
  const complete = completedSlides.size + (latestResult?.pass ? 1 : 0);
  const percent = Math.round(complete / course.slides.length * 100);
  document.getElementById("pct").textContent = `${percent}%`;
  document.getElementById("bar").style.width = `${percent}%`;
  document.getElementById("progress-detail").textContent = latestResult?.pass
    ? course.practicalRequired ? "Theory passed · practical verification pending" : "Online theory completed"
    : `${completedSlides.size} of ${learningSlides} slide checks recorded`;
}

function renderNav() {
  if (!course) return;
  ui.nav.replaceChildren();
  const finalIndex = course.slides.length - 1;
  course.slides.forEach((slide, index) => {
    const available = canOpen(index);
    const button = document.createElement("button");
    button.disabled = !available;
    button.classList.toggle("active", index === finalIndex
      ? !ui.assessment.classList.contains("hidden")
      : !ui.lesson.classList.contains("hidden") && currentIndex === index);
    button.setAttribute("aria-label", `Slide ${slide.id}: ${slide.title}${available ? "" : ", locked"}`);
    const complete = index === finalIndex ? latestResult?.pass : isComplete(slide.id);
    button.innerHTML = `<span class="navnum">${slide.id}</span><span>${safe(slide.title)}</span><span class="navstatus" aria-hidden="true">${complete ? "✓" : available ? "" : "🔒"}</span>`;
    button.addEventListener("click", () => index === finalIndex ? showAssessment() : showSlide(index));
    ui.nav.appendChild(button);
  });
  renderProgress();
}

async function getSlideUrl(slideNumber) {
  const cached = slideUrls.get(slideNumber);
  if (cached && cached.expiresAt > Date.now() + 15000) return cached.url;
  const data = await api(config.trainingFunction, {
    action: "slide",
    assignmentId,
    slideNumber
  });
  const value = { url: data.url, expiresAt: Date.now() + Number(data.expiresIn || 120) * 1000 };
  slideUrls.set(slideNumber, value);
  return value.url;
}

async function preloadSlide(slideNumber) {
  if (!course || slideNumber < 1 || slideNumber > course.slides.length || preloadedSlides.has(slideNumber)) return;
  preloadedSlides.add(slideNumber);
  try {
    const url = await getSlideUrl(slideNumber);
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "low";
    image.src = url;
    if (typeof image.decode === "function") await image.decode().catch(() => {});
  } catch (_) {
    preloadedSlides.delete(slideNumber);
  }
}

async function loadImage(container, slide) {
  const image = container.querySelector("[data-slide-image]");
  const status = container.querySelector("[data-image-status]");
  try {
    image.loading = "eager";
    image.decoding = "async";
    image.fetchPriority = "high";
    const url = await getSlideUrl(slide.id);
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", reject, { once: true });
      image.src = url;
    });
    status?.remove();
    image.classList.add("ready");
  } catch (error) {
    if (status) status.textContent = friendlyError(error);
  }
}

function slideMarkup(slide) {
  return `<div class="slidehead"><div><p class="eyebrow">POWERPOINT SLIDE ${slide.id} OF ${course.slides.length}</p><h1>${safe(slide.title)}</h1></div><span class="slidepill">${slide.check?.critical ? "CRITICAL CHECK" : "TRAINING"}</span></div>
    <div class="slidevisual"><div class="image-status" data-image-status role="status">Loading slide ${slide.id}…</div><img data-slide-image alt="PowerPoint slide ${slide.id}: ${safe(slide.title)}" width="1921" height="1080"></div>
    <section class="contentcard transcript"><h2>Key points</h2><ul>${slide.bullets.map(point => `<li>${safe(point)}</li>`).join("")}</ul></section>`;
}

async function showSlide(index) {
  if (!canOpen(index) || index >= course.slides.length - 1) return;
  currentIndex = index;
  const slide = course.slides[index];
  const done = isComplete(slide.id);
  const check = slide.check;
  ui.lesson.innerHTML = slideMarkup(slide) +
    `<section class="checkpoint" aria-labelledby="check-title"><span class="slidepill ${check.critical ? "critical" : ""}">${check.critical ? "CRITICAL CHECKPOINT" : "KNOWLEDGE CHECK"}</span><h2 id="check-title">Check your decision</h2><p class="q">${safe(check.question)}</p>
      <fieldset ${done ? "disabled" : ""}><legend class="sr-only">Choose one answer</legend>${check.options.map((option, optionIndex) => `<label class="option"><input type="radio" name="checkpoint" value="${optionIndex}"> <span>${safe(option)}</span></label>`).join("")}</fieldset>
      <button class="primary" id="check-answer" ${done ? "disabled" : ""}>${done ? "Checkpoint recorded" : "Check answer"}</button><div id="checkpoint-feedback" role="status" aria-live="polite">${done ? '<div class="feedback ok">Completed and recorded for this assignment.</div>' : ""}</div></section>
      <div class="actions"><button class="secondary" id="previous" ${index === 0 ? "disabled" : ""}>Previous slide</button><button class="primary" id="next" ${done ? "" : "disabled"}>${index === course.slides.length - 2 ? "Final assessment" : "Next slide"}</button></div>`;
  show("lesson");
  loadImage(ui.lesson, slide).then(() => {
    if (isComplete(slide.id)) preloadSlide(slide.id + 1);
  });
  ui.lesson.querySelector("#previous").addEventListener("click", () => showSlide(index - 1));
  ui.lesson.querySelector("#next").addEventListener("click", () => index === course.slides.length - 2 ? showAssessment() : showSlide(index + 1));
  ui.lesson.querySelector("#check-answer").addEventListener("click", async event => {
    const button = event.currentTarget;
    const selected = ui.lesson.querySelector('input[name="checkpoint"]:checked');
    const feedback = ui.lesson.querySelector("#checkpoint-feedback");
    if (!selected) {
      feedback.innerHTML = '<div class="feedback no">Choose an answer first.</div>';
      return;
    }
    button.disabled = true;
    feedback.innerHTML = '<div class="feedback pending">Checking and recording your answer…</div>';
    try {
      const result = await api(config.trainingFunction, {
        action: "check",
        assignmentId,
        slideNumber: slide.id,
        selectedAnswer: Number(selected.value)
      });
      if (!result.correct) {
        feedback.innerHTML = '<div class="feedback no">Review the slide and key points, then try again.</div>';
        button.disabled = false;
        return;
      }
      completedSlides.add(slide.id);
      preloadSlide(slide.id + 1);
      feedback.innerHTML = `<div class="feedback ok">Correct. ${safe(result.feedback || "Your checkpoint has been recorded.")}</div>`;
      ui.lesson.querySelectorAll('input[name="checkpoint"]').forEach(input => { input.disabled = true; });
      ui.lesson.querySelector("#next").disabled = false;
      button.textContent = "Checkpoint recorded";
      renderNav();
    } catch (error) {
      feedback.innerHTML = `<div class="feedback no">${safe(friendlyError(error))}</div>`;
      button.disabled = false;
    }
  });
}

async function showAssessment() {
  const finalIndex = course.slides.length - 1;
  if (!canOpen(finalIndex)) return;
  const slide = course.slides[finalIndex];
  ui.assessment.innerHTML = slideMarkup(slide) +
    `<section class="checkpoint" aria-labelledby="exam-title"><span class="slidepill critical">FINAL THEORY ASSESSMENT</span><h2 id="exam-title">Apply what you learned</h2><p>Pass rule: at least ${course.passMark}% overall and every critical question correct. ${course.practicalRequired ? "An online pass leaves practical verification pending." : "A passing result completes this online theory requirement."}</p>
      ${course.exam.map((question, index) => `<fieldset class="examq ${question.critical ? "critical" : ""}"><legend>Q${index + 1}. ${safe(question.question)} ${question.critical ? '<span class="badge">CRITICAL</span>' : ""}</legend>${question.options.map((option, optionIndex) => `<label class="option"><input type="radio" name="exam-${index}" value="${optionIndex}"> <span>${safe(option)}</span></label>`).join("")}</fieldset>`).join("")}
      <button class="primary large" id="submit-exam">Submit final assessment</button><div id="result" role="status" aria-live="polite"></div></section>
      <div class="actions"><button class="secondary" id="back-slide">Back to slide ${finalIndex}</button></div>`;
  show("assessment");
  loadImage(ui.assessment, slide);
  ui.assessment.querySelector("#back-slide").addEventListener("click", () => showSlide(finalIndex - 1));
  ui.assessment.querySelector("#submit-exam").addEventListener("click", submitAssessment);
  if (latestResult) renderResult(latestResult);
}

async function submitAssessment(event) {
  const button = event.currentTarget;
  const answers = course.exam.map((_, index) => {
    const selected = ui.assessment.querySelector(`input[name="exam-${index}"]:checked`);
    return selected ? Number(selected.value) : null;
  });
  const firstMissing = answers.indexOf(null);
  if (firstMissing >= 0) {
    ui.assessment.querySelector("#result").innerHTML = `<div class="feedback no">Answer all questions before submitting. Question ${firstMissing + 1} is incomplete.</div>`;
    ui.assessment.querySelectorAll(".examq")[firstMissing].scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  button.disabled = true;
  ui.assessment.querySelector("#result").innerHTML = '<div class="feedback pending">Submitting for secure marking…</div>';
  try {
    latestResult = await api(config.trainingFunction, { action: "submit_exam", assignmentId, answers });
    renderResult(latestResult);
    renderNav();
  } catch (error) {
    ui.assessment.querySelector("#result").innerHTML = `<div class="feedback no">${safe(friendlyError(error))}</div>`;
    button.disabled = false;
  }
}

function renderResult(result) {
  const target = ui.assessment.querySelector("#result");
  if (!target) return;
  const passedHeading = course.practicalRequired ? "THEORY PASSED · PRACTICAL VERIFICATION PENDING" : "ONLINE THEORY COMPLETED";
  const passedMessage = course.practicalRequired
    ? "Your theory result is recorded. A competent assessor must complete the required onsite practical verification before task authorisation."
    : "Your online theory result is recorded as complete.";
  target.innerHTML = `<div class="result ${result.pass ? "pass" : "fail"}"><h2>${result.pass ? passedHeading : "FURTHER TRAINING REQUIRED"}</h2>
    <p><strong>Verified learner:</strong> ${safe(learner.fullName)} · <strong>Score:</strong> ${result.correct}/${result.total} (${result.score}%) · <strong>Critical questions:</strong> ${result.criticalPassed ? "PASS" : "NOT PASSED"}</p>
    <p><strong>Attempt:</strong> ${result.attemptNumber} · <strong>Date taken:</strong> ${safe(formatDate(result.submittedAt, true))}</p>
    <p>${result.pass ? passedMessage : `Review the module and retake the assessment. Questions to revisit: ${(result.missedQuestionNumbers || []).join(", ")}.`}</p>
    ${result.pass ? `<p><strong>Certificate number:</strong> ${safe(result.certificateNumber || "Preparing certificate")}</p><button class="primary" id="certificate">Open certificate (PDF)</button><p id="certificate-message" class="certificate-message" role="status"></p>` : ""}</div>`;
  const submitButton = ui.assessment.querySelector("#submit-exam");
  if (submitButton) {
    submitButton.disabled = false;
    submitButton.textContent = "Submit another attempt";
  }
  target.querySelector("#certificate")?.addEventListener("click", openCertificate);
}

async function openCertificate(event) {
  const button = event.currentTarget;
  const message = ui.assessment.querySelector("#certificate-message");
  button.disabled = true;
  message.textContent = "Preparing a secure certificate link…";
  try {
    const data = await api(config.trainingFunction, {
      action: "certificate",
      assignmentId,
      attemptId: latestResult.id
    });
    const link = document.createElement("a");
    link.href = data.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
    message.textContent = course.practicalRequired ? "Certificate opened. Practical verification remains pending." : "Certificate opened.";
  } catch (error) {
    message.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
}

async function loadCover() {
  const image = document.getElementById("cover-image");
  const status = document.getElementById("cover-status");
  try {
    image.loading = "eager";
    image.decoding = "async";
    image.fetchPriority = "high";
    const url = await getSlideUrl(1);
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", reject, { once: true });
      image.src = url;
    });
    status?.remove();
    image.classList.add("ready");
  } catch (error) {
    status.textContent = friendlyError(error);
  }
}

document.getElementById("sign-out").addEventListener("click", async () => {
  await signOut();
  window.location.href = "../../";
});

async function init() {
  completeAuthRedirect();
  if (!isConfigured()) {
    showGate("Secure service connection pending", "The protected training backend has not been connected yet.");
    return;
  }
  if (!assignmentId) {
    showGate("No assignment selected", "Open this module from your assigned training list.");
    return;
  }
  if (!await getSession()) {
    showGate("Email verification required", "Sign in through the training portal with the email address used for this assignment.");
    return;
  }

  try {
    const data = await api(config.trainingFunction, { action: "module", assignmentId });
    assignment = data.assignment;
    course = data.module;
    learner = data.learner;
    latestResult = data.latestResult;
    completedSlides = new Set(data.completedSlides || []);
    currentIndex = Math.max(0, Math.min(course.slides.length - 2, Number(window.localStorage.getItem(`panalo-current-${assignmentId}`)) || 0));

    document.title = `${course.code} | ${course.title}`;
    document.getElementById("account-email").textContent = learner.email;
    document.getElementById("course-title").textContent = course.title;
    document.getElementById("course-revision").textContent = course.revision;
    document.getElementById("module-status").textContent = course.status === "draft" ? "DRAFT · ASSIGNED PILOT" : "CONTROLLED TRAINING";
    document.getElementById("landing-title").textContent = course.title;
    document.getElementById("cover-caption").textContent = `PowerPoint cover · ${course.code} · ${course.slides.length} slides · ${course.revision}`;
    document.getElementById("learner-name").textContent = learner.fullName;
    document.getElementById("assignment-expiry").textContent = formatDate(assignment.expiresAt);
    const theoryRule = document.getElementById("theory-pass-rule");
    if (theoryRule) theoryRule.textContent = `${course.passMark}% overall + 100% critical questions`;
    const practicalRule = document.getElementById("practical-rule");
    if (practicalRule) practicalRule.textContent = course.practicalRequired ? "Required" : "Not required for this module";
    ui.start.addEventListener("click", () => showSlide(canOpen(currentIndex) ? currentIndex : 0));
    show("landing");
    loadCover();
  } catch (error) {
    showGate("Assignment unavailable", friendlyError(error));
  }
}

window.addEventListener("beforeunload", () => {
  if (assignmentId) window.localStorage.setItem(`panalo-current-${assignmentId}`, String(currentIndex));
});

init();
