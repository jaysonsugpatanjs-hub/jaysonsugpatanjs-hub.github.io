import {
  api,
  completeAuthRedirect,
  config,
  friendlyError,
  getSession,
  isConfigured,
  requestPasswordReset,
  signInWithPassword,
  signOut
} from "./auth.js";

const $ = id => document.getElementById(id);
const ui = {
  setup: $("setup-panel"),
  signIn: $("sign-in-panel"),
  password: $("password-panel"),
  dashboard: $("dashboard"),
  form: $("sign-in-form"),
  resetForm: $("reset-form"),
  passwordForm: $("password-form"),
  authMessage: $("auth-message"),
  resetMessage: $("reset-message"),
  passwordMessage: $("password-message"),
  dashboardMessage: $("dashboard-message"),
  moduleGrid: $("module-grid"),
  signOut: $("sign-out"),
  adminLink: $("admin-link"),
  imsLink: $("ims-link"),
  onboarding: $("onboarding")
};

function show(name) {
  ui.setup.classList.toggle("hidden", name !== "setup");
  ui.signIn.classList.toggle("hidden", name !== "signIn");
  ui.password.classList.toggle("hidden", name !== "password");
  ui.dashboard.classList.toggle("hidden", name !== "dashboard");
  ui.signOut.classList.toggle("hidden", !["dashboard", "password"].includes(name));
  ui.imsLink.classList.toggle("hidden", name !== "dashboard");
  if (name !== "dashboard") ui.adminLink.classList.add("hidden");
}

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "No expiry set";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(value));
}

function askForPassword(reason) {
  const intro = {
    invite: ["Welcome to Panalo", "Choose the password you'll use to sign in from now on."],
    recovery: ["Reset your password", "Choose a new password. It replaces your old one straight away."],
    temporary: ["Choose your own password", "You signed in with a temporary password. Choose your own to continue."]
  }[reason] || ["Choose your password", "Set a password you'll use to sign in from now on."];
  $("password-title").textContent = intro[0];
  $("password-intro").textContent = intro[1];
  ui.passwordForm.reset();
  ui.passwordMessage.textContent = "";
  show("password");
  $("new-password").focus();
}

function renderAssignments(assignments) {
  ui.moduleGrid.replaceChildren();
  $("assignment-count").textContent = `${assignments.length} active assignment${assignments.length === 1 ? "" : "s"}`;
  if (!assignments.length) {
    const empty = document.createElement("article");
    empty.className = "module-card empty-assignment";
    empty.innerHTML = "<div class=\"module-body\"><div class=\"code\">NO ACTIVE MODULES</div><h3>No training is assigned to you yet</h3><p>Contact the Panalo Pipes training administrator if you expected an assignment.</p></div>";
    ui.moduleGrid.appendChild(empty);
    return;
  }
  assignments.forEach(assignment => {
    const card = document.createElement("a");
    card.className = "module-card available secure-module";
    card.href = `./modules/?assignment=${encodeURIComponent(assignment.id)}`;
    const progress = Number(assignment.progressPercent || 0);
    const status = assignment.theoryPassedAt ? "THEORY PASSED" : progress ? "IN PROGRESS" : "ASSIGNED";
    card.innerHTML = `<div class="module-visual secure-cover"><div><span>${safe(assignment.module.code)}</span><strong>${safe(assignment.module.title)}</strong></div><span class="status">${status}</span></div>
      <div class="module-body"><div class="code">${safe(assignment.module.code)} · ${safe(assignment.module.revision)}</div><h3>${safe(assignment.module.title)}</h3>
      <p>${safe(assignment.module.description)}</p><div class="progress-line" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i></i></div>
      <div class="meta"><span>${progress}% complete</span><span>Expires ${safe(formatDate(assignment.expiresAt))}</span><span>${assignment.module.practicalRequired ? "Practical verification required" : "Online theory"}</span></div>
      <div class="open">${assignment.theoryPassedAt ? "View result and certificate" : "Open assigned module"}<span>→</span></div></div>`;
    // Set through the DOM: the page's security policy blocks inline style attributes.
    card.querySelector(".progress-line i").style.width = `${Math.max(0, Math.min(100, progress))}%`;
    ui.moduleGrid.appendChild(card);
  });
}

/* ---------------- Onboarding documents ---------------- */

const ITEM_STATUS = {
  pending: ["To upload", "pending"],
  uploaded: ["Uploaded · waiting for HR", "info"],
  accepted: ["Accepted", "good"],
  rejected: ["Needs another upload", "bad"]
};

async function loadOnboarding() {
  const data = await api(config.trainingFunction, { action: "onboarding_view" });
  if (!data.request || data.request.status !== "open") {
    ui.onboarding.classList.add("hidden");
    return;
  }
  const items = data.items || [];
  const required = items.filter(i => i.required);
  const done = required.filter(i => i.status === "accepted").length;
  $("onboarding-progress").textContent = `${done} of ${required.length} required documents accepted`;
  $("onboarding-intro").textContent = [
    data.request.message,
    data.request.dueOn ? `Due by ${formatDate(data.request.dueOn)}.` : ""
  ].filter(Boolean).join(" ") || "Please upload each document below. A clear phone photo or a PDF is fine.";
  $("onboarding-items").innerHTML = items.map(item => {
    const [label, tone] = ITEM_STATUS[item.status] || [item.status, ""];
    const canUpload = item.status !== "accepted";
    return `<article class="onboarding-item">
      <div class="onboarding-text">
        <div class="onboarding-title"><strong>${safe(item.name)}</strong>
          ${item.required ? "" : '<span class="chip">Optional</span>'}
          ${item.sensitive ? '<span class="chip info">Restricted to HR</span>' : ""}</div>
        <p class="muted small">${safe(item.guidance)}</p>
        ${item.fileName ? `<p class="small">Your file: ${safe(item.fileName)}${item.uploadedAt ? ` · ${safe(formatDate(item.uploadedAt))}` : ""}</p>` : ""}
        ${item.status === "rejected" && item.rejectReason ? `<p class="reject-note">HR says: ${safe(item.rejectReason)}</p>` : ""}
      </div>
      <div class="onboarding-actions">
        <span class="chip ${tone}">${label}</span>
        ${canUpload ? `<label class="upload-button">
          <input type="file" data-item="${safe(item.id)}" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*">
          <span>${item.fileName ? "Replace file" : "Upload"}</span></label>` : ""}
      </div>
    </article>`;
  }).join("");
  ui.onboarding.classList.remove("hidden");
}

async function uploadOnboardingFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const message = $("onboarding-message");
  if (file.size > 20 * 1024 * 1024) {
    message.textContent = "That file is over 20 MB. Try a PDF or a smaller photo.";
    input.value = "";
    return;
  }
  input.disabled = true;
  message.textContent = `Uploading ${file.name}…`;
  try {
    const prepared = await api(config.trainingFunction, { action: "onboarding_prepare_upload", itemId: input.dataset.item, fileName: file.name, size: file.size });
    const res = await fetch(prepared.signedUrl, { method: "PUT", headers: { "Content-Type": prepared.contentType }, body: file });
    if (!res.ok) throw new Error(`The upload failed (${res.status}). Please try again.`);
    await api(config.trainingFunction, { action: "onboarding_attach", itemId: input.dataset.item, path: prepared.path, fileName: file.name });
    await loadOnboarding();
    message.textContent = `${file.name} uploaded. HR will review it.`;
  } catch (error) {
    message.textContent = friendlyError(error);
    input.disabled = false;
    input.value = "";
  }
}

/* ---------------- Dashboard ---------------- */

async function loadDashboard() {
  ui.dashboardMessage.textContent = "Loading…";
  try {
    const data = await api(config.trainingFunction, { action: "bootstrap" });
    if (data.learner.mustChangePassword) {
      askForPassword("temporary");
      return;
    }
    show("dashboard");
    $("learner-name").textContent = data.learner.fullName || "Panalo learner";
    $("learner-email").textContent = data.learner.email;
    $("learner-id").textContent = data.learner.externalId || "Not assigned";
    ui.adminLink.classList.toggle("hidden", !data.learner.hasAdminAccess);
    renderAssignments(data.assignments || []);
    if (data.onboarding) await loadOnboarding();
    else ui.onboarding.classList.add("hidden");
    ui.dashboardMessage.textContent = "";
  } catch (error) {
    if (error.status === 401) {
      await signOut();
      show("signIn");
      ui.authMessage.textContent = friendlyError(error);
      return;
    }
    show("dashboard");
    ui.dashboardMessage.textContent = friendlyError(error);
  }
}

ui.form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.form.querySelector('button[type="submit"]');
  button.disabled = true;
  ui.authMessage.textContent = "Signing in…";
  try {
    await signInWithPassword($("email").value, $("password").value);
    ui.form.reset();
    ui.authMessage.textContent = "";
    await loadDashboard();
  } catch (error) {
    ui.authMessage.textContent = friendlyError(error);
    $("password").value = "";
  } finally {
    button.disabled = false;
  }
});

$("forgot-link").addEventListener("click", () => {
  ui.form.classList.add("hidden");
  ui.resetForm.classList.remove("hidden");
  $("reset-email").value = $("email").value;
  $("reset-email").focus();
});
$("back-to-sign-in").addEventListener("click", () => {
  ui.resetForm.classList.add("hidden");
  ui.form.classList.remove("hidden");
});

ui.resetForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.resetForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await requestPasswordReset($("reset-email").value);
    ui.resetMessage.textContent = "If that email has a Panalo account, a reset link is on its way. It works once and expires soon.";
  } catch (error) {
    ui.resetMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

ui.passwordForm.addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("new-password").value;
  if (password !== $("confirm-password").value) {
    ui.passwordMessage.textContent = "The two passwords don't match.";
    return;
  }
  const button = ui.passwordForm.querySelector('button[type="submit"]');
  button.disabled = true;
  ui.passwordMessage.textContent = "Saving…";
  try {
    await api(config.trainingFunction, { action: "change_password", password });
    ui.passwordForm.reset();
    ui.passwordMessage.textContent = "";
    await loadDashboard();
  } catch (error) {
    ui.passwordMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

$("onboarding-items").addEventListener("change", event => {
  if (event.target.matches("input[type=file][data-item]")) uploadOnboardingFile(event.target);
});

ui.signOut.addEventListener("click", async () => {
  await signOut();
  show("signIn");
});

async function init() {
  const callback = completeAuthRedirect();
  if (!isConfigured()) {
    show("setup");
    return;
  }
  if (callback.error) ui.authMessage.textContent = callback.error;
  if (callback.authenticated && (callback.type === "invite" || callback.type === "recovery")) {
    askForPassword(callback.type);
    return;
  }
  if (await getSession()) await loadDashboard();
  else show("signIn");
}

init();
