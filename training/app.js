import {
  api,
  completeAuthRedirect,
  config,
  friendlyError,
  getSession,
  isConfigured,
  sendMagicLink,
  signOut
} from "./auth.js";

const ui = {
  setup: document.getElementById("setup-panel"),
  signIn: document.getElementById("sign-in-panel"),
  dashboard: document.getElementById("dashboard"),
  form: document.getElementById("sign-in-form"),
  email: document.getElementById("email"),
  authMessage: document.getElementById("auth-message"),
  dashboardMessage: document.getElementById("dashboard-message"),
  moduleGrid: document.getElementById("module-grid"),
  signOut: document.getElementById("sign-out"),
  adminLink: document.getElementById("admin-link"),
  imsLink: document.getElementById("ims-link")
};

function show(name) {
  ui.setup.classList.toggle("hidden", name !== "setup");
  ui.signIn.classList.toggle("hidden", name !== "signIn");
  ui.dashboard.classList.toggle("hidden", name !== "dashboard");
  ui.signOut.classList.toggle("hidden", name !== "dashboard");
  ui.imsLink.classList.toggle("hidden", name !== "dashboard");
}

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "No expiry set";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeZone: "Australia/Sydney"
  }).format(new Date(value));
}

function renderAssignments(assignments) {
  ui.moduleGrid.replaceChildren();
  document.getElementById("assignment-count").textContent = `${assignments.length} active assignment${assignments.length === 1 ? "" : "s"}`;

  if (!assignments.length) {
    const empty = document.createElement("article");
    empty.className = "module-card empty-assignment";
    empty.innerHTML = "<div class=\"module-body\"><div class=\"code\">NO ACTIVE MODULES</div><h3>No training is assigned to this email</h3><p>Contact the Panalo Pipes training administrator if you expected an assignment.</p></div>";
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
      <p>${safe(assignment.module.description)}</p><div class="progress-line"><i style="width:${Math.max(0, Math.min(100, progress))}%"></i></div>
      <div class="meta"><span>${progress}% complete</span><span>Expires ${safe(formatDate(assignment.expiresAt))}</span><span>${assignment.module.practicalRequired ? "Practical verification required" : "Online theory"}</span></div>
      <div class="open">${assignment.theoryPassedAt ? "View result and certificate" : "Open assigned module"}<span>→</span></div></div>`;
    ui.moduleGrid.appendChild(card);
  });
}

async function loadDashboard() {
  show("dashboard");
  ui.dashboardMessage.textContent = "Loading your assignments…";
  try {
    const data = await api(config.trainingFunction, { action: "bootstrap" });
    document.getElementById("learner-name").textContent = data.learner.fullName || "Invited learner";
    document.getElementById("learner-email").textContent = data.learner.email;
    document.getElementById("learner-id").textContent = data.learner.externalId || "Not assigned";
    ui.adminLink.classList.toggle("hidden", data.learner.role !== "admin");
    renderAssignments(data.assignments || []);
    ui.dashboardMessage.textContent = "";
  } catch (error) {
    if (error.status === 401) {
      await signOut();
      show("signIn");
      ui.authMessage.textContent = friendlyError(error);
      return;
    }
    ui.dashboardMessage.textContent = friendlyError(error);
  }
}

ui.form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = ui.form.querySelector("button");
  button.disabled = true;
  ui.authMessage.textContent = "Sending a secure sign-in link…";
  try {
    await sendMagicLink(ui.email.value);
    ui.authMessage.textContent = "Check your email and open the Panalo Pipes sign-in link. The link is time-limited and can be used once.";
    ui.form.reset();
  } catch (error) {
    // Do not reveal whether a particular email is registered.
    ui.authMessage.textContent = error.status === 422 || error.status === 400
      ? "If this address has an active invitation, a sign-in link will be sent. Contact the training administrator if it does not arrive."
      : friendlyError(error);
  } finally {
    button.disabled = false;
  }
});

ui.signOut.addEventListener("click", async () => {
  await signOut();
  ui.adminLink.classList.add("hidden");
  show("signIn");
});

async function init() {
  const callback = completeAuthRedirect();
  if (!isConfigured()) {
    show("setup");
    return;
  }
  if (callback.error) ui.authMessage.textContent = callback.error;
  if (await getSession()) await loadDashboard();
  else show("signIn");
}

init();
