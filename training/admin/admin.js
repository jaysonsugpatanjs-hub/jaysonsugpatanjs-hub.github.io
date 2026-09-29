import { api, completeAuthRedirect, config, friendlyError, getSession, isConfigured, signOut } from "../auth.js";

const ui = {
  gate: document.getElementById("admin-gate"),
  app: document.getElementById("admin-app"),
  form: document.getElementById("invite-form"),
  inviteMessage: document.getElementById("invite-message"),
  registerBody: document.getElementById("register-body"),
  registerMessage: document.getElementById("register-message"),
  search: document.getElementById("search")
};
let data = null;

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(value)) : "—";
}

function defaultExpiry() {
  const date = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function renderSummary(summary) {
  document.getElementById("summary").innerHTML = [
    ["Active learners", summary.activeLearners],
    ["Open assignments", summary.openAssignments],
    ["Theory passed", summary.theoryPassed]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function statusLabel(assignment) {
  if (assignment.status === "revoked") return "Revoked";
  if (new Date(assignment.expiresAt).getTime() <= Date.now()) return "Expired";
  if (assignment.status === "theory_passed") return "Theory passed";
  return "Assigned";
}

function renderRegister() {
  const term = ui.search.value.trim().toLowerCase();
  const assignments = (data?.assignments || []).filter(assignment => {
    const haystack = [assignment.learner?.full_name, assignment.learner?.email, assignment.learner?.external_id, assignment.module?.code, assignment.module?.title].join(" ").toLowerCase();
    return !term || haystack.includes(term);
  });
  ui.registerBody.innerHTML = assignments.map(assignment => {
    const active = !["revoked"].includes(assignment.status) && new Date(assignment.expiresAt).getTime() > Date.now();
    const result = assignment.latestAttempt
      ? `${assignment.latestAttempt.score}% · ${assignment.latestAttempt.pass ? "Pass" : "Not passed"}`
      : "Not attempted";
    return `<tr><td><strong>${safe(assignment.learner?.full_name || "Unknown learner")}</strong><small>${safe(assignment.learner?.email || "")}</small><small>${safe(assignment.learner?.external_id || "No record ID")}</small></td>
      <td><strong>${safe(assignment.module?.code || "Unknown")}</strong><small>${safe(assignment.module?.revision || "")}</small></td><td><span class="status-chip ${safe(statusLabel(assignment).toLowerCase().replace(/\s/g, "-"))}">${safe(statusLabel(assignment))}</span></td>
      <td>${safe(result)}<small>${assignment.latestAttempt ? `Attempt ${assignment.latestAttempt.attemptNumber} · ${safe(formatDate(assignment.latestAttempt.submittedAt))}` : ""}</small></td><td>${safe(formatDate(assignment.expiresAt))}</td>
      <td>${active ? `<button class="revoke" type="button" data-assignment="${safe(assignment.id)}" data-learner="${safe(assignment.learner?.full_name || assignment.learner?.email)}">Revoke</button>` : "—"}</td></tr>`;
  }).join("");
  ui.registerMessage.textContent = assignments.length ? "" : "No assignments match this search.";
  ui.registerBody.querySelectorAll(".revoke").forEach(button => button.addEventListener("click", revokeAssignment));
}

async function loadDashboard() {
  ui.registerMessage.textContent = "Loading the controlled register…";
  data = await api(config.adminFunction, { action: "dashboard" });
  document.getElementById("admin-identity").textContent = `Signed in as ${data.administrator.fullName || data.administrator.email}`;
  renderSummary(data.summary);
  const moduleSelect = document.getElementById("module-code");
  moduleSelect.innerHTML = data.modules.filter(module => module.published).map(module => `<option value="${safe(module.code)}">${safe(module.code)} — ${safe(module.title)} (${safe(module.revision)})</option>`).join("");
  renderRegister();
}

async function revokeAssignment(event) {
  const button = event.currentTarget;
  const learner = button.dataset.learner;
  if (!window.confirm(`Revoke ${learner}'s access to this assignment? Their existing audit records will be retained.`)) return;
  button.disabled = true;
  ui.registerMessage.textContent = "Revoking access…";
  try {
    await api(config.adminFunction, { action: "revoke", assignmentId: button.dataset.assignment, reason: "Access ended by training administrator" });
    await loadDashboard();
    ui.registerMessage.textContent = "Access revoked and recorded.";
  } catch (error) {
    ui.registerMessage.textContent = friendlyError(error);
    button.disabled = false;
  }
}

ui.form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.form.querySelector('button[type="submit"]');
  const form = new FormData(ui.form);
  const expiresOn = String(form.get("expiresOn"));
  const expiresAt = new Date(Date.parse(`${expiresOn}T00:00:00Z`) + 24 * 60 * 60 * 1000 - 1).toISOString();
  button.disabled = true;
  ui.inviteMessage.textContent = "Creating controlled access and sending the invitation…";
  try {
    const result = await api(config.adminFunction, {
      action: "invite",
      fullName: form.get("fullName"),
      email: form.get("email"),
      learnerType: form.get("learnerType"),
      externalId: form.get("externalId"),
      moduleCode: form.get("moduleCode"),
      expiresAt
    });
    ui.inviteMessage.textContent = result.invitationSent
      ? "Invitation sent and module assigned."
      : "Existing verified account updated and module assigned.";
    ui.form.reset();
    document.getElementById("expires-on").value = defaultExpiry();
    await loadDashboard();
  } catch (error) {
    ui.inviteMessage.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

ui.search.addEventListener("input", renderRegister);
document.getElementById("refresh").addEventListener("click", () => loadDashboard().catch(error => { ui.registerMessage.textContent = friendlyError(error); }));
document.getElementById("sign-out").addEventListener("click", async () => { await signOut(); window.location.href = "../"; });

async function init() {
  completeAuthRedirect();
  document.getElementById("expires-on").value = defaultExpiry();
  if (!isConfigured()) {
    document.getElementById("gate-title").textContent = "Secure service connection pending";
    document.getElementById("gate-message").textContent = "The protected training backend has not been connected yet.";
    return;
  }
  if (!await getSession()) {
    document.getElementById("gate-title").textContent = "Administrator sign-in required";
    document.getElementById("gate-message").textContent = "Sign in through the learner portal using an administrator email.";
    return;
  }
  try {
    await loadDashboard();
    ui.gate.classList.add("hidden");
    ui.app.classList.remove("hidden");
  } catch (error) {
    document.getElementById("gate-title").textContent = "Administrator access unavailable";
    document.getElementById("gate-message").textContent = friendlyError(error);
  }
}

init();
