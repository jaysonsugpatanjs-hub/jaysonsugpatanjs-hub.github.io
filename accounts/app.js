// Panalo Accounts shell: sign-in gate, MFA, navigation, notifications and
// the hash router. Every screen loads its data through finance-api, which
// checks permissions again on the server.
import { completeAuthRedirect, getSession, isConfigured, mfaEnroll, mfaFactors, mfaVerify, sessionAal, signOut } from "../training/auth.js";
import { call, dateTime, friendlyError, safe } from "./lib/ui.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderCompany } from "./views/company.js";
import { renderUsers } from "./views/users.js";
import { renderApprovals } from "./views/approvals.js";
import { renderAudit } from "./views/audit.js";
import { renderIntegrations } from "./views/integrations.js";
import { renderPlanned } from "./views/planned.js";
import { renderChart } from "./views/chart.js";
import { renderTaxCodes } from "./views/taxcodes.js";
import { renderJournals } from "./views/journals.js";
import { renderPeriods } from "./views/periods.js";
import { renderReports } from "./views/reports.js";
import { renderCustomers } from "./views/customers.js";
import { renderQuotes } from "./views/quotes.js";
import { renderInvoices } from "./views/invoices.js";
import { renderReceipts } from "./views/receipts.js";
import { renderSuppliers } from "./views/suppliers.js";
import { renderPurchaseOrders } from "./views/purchase-orders.js";
import { renderBills } from "./views/bills.js";
import { renderSupplierPayments } from "./views/supplier-payments.js";
import { renderJobCosting, renderProjects } from "./views/projects.js";
import { renderTimesheets } from "./views/timesheets.js";
import { renderEmployees } from "./views/employees.js";
import { renderPayRuns, renderPayrollReports, renderSuper } from "./views/payruns.js";
import { renderLeave, renderMyPay } from "./views/leave.js";

const $ = sel => document.querySelector(sel);
const state = { me: null };
const can = key => state.me?.permissions.includes(key);

const LEDGER = ["reports.view", "ledger.manage", "ledger.journal", "ledger.post", "audit.view"];
const SALES = ["sales.manage", "bank.manage", "reports.view"];
const PURCHASES = ["purchases.manage", "purchases.raise", "bank.manage", "reports.view"];
const RUNS = ["payroll.run", "payroll.approve", "payroll.sensitive"];
/* Menu from the brief (section 80). Items not built yet show the phase that delivers them. */
const MENU = [
  { group: null, items: [{ path: "dashboard", label: "Dashboard" }, { path: "my-pay", label: "My pay", perm: "payroll.self" }] },
  { group: "Sales", items: [
    { path: "customers", label: "Customers", any: SALES }, { path: "quotes", label: "Quotes", any: SALES },
    { path: "invoices", label: "Invoices", any: SALES }, { path: "receipts", label: "Payments received", any: SALES }] },
  { group: "Purchases", items: [
    { path: "suppliers", label: "Suppliers", any: PURCHASES }, { path: "purchase-orders", label: "Purchase orders", any: PURCHASES },
    { path: "bills", label: "Bills", any: ["purchases.manage", "bank.manage", "reports.view"] }, { path: "supplier-payments", label: "Supplier payments", any: ["purchases.manage", "bank.manage", "reports.view"] }] },
  { group: "Projects", items: [
    { path: "projects", label: "Projects", any: ["projects.manage", "reports.view"] },
    { path: "job-costing", label: "Job costing", any: ["projects.manage", "reports.view"] },
    { path: "timesheets", label: "Timesheets", any: ["time.submit", "time.approve", "projects.manage", "payroll.run"], count: "timesheets" }] },
  { group: "Payroll", items: [
    { path: "employees", label: "Employees", any: ["payroll.sensitive", "payroll.run", "payroll.approve", "leave.approve"] },
    { path: "pay-runs", label: "Pay runs", any: RUNS, count: "payRuns" },
    { path: "leave", label: "Leave", any: ["leave.approve", "payroll.sensitive", "payroll.run"], count: "leave" },
    { path: "super", label: "Super", any: RUNS },
    ["stp", "STP", 8],
    { path: "payroll-reports", label: "Payroll reports", any: RUNS }] },
  { group: "Accounting", items: [
    { path: "reports", label: "Reports", any: LEDGER },
    { path: "journals", label: "Journals", any: LEDGER },
    { path: "chart-of-accounts", label: "Chart of accounts", any: LEDGER },
    { path: "tax-codes", label: "Tax codes", any: LEDGER },
    { path: "periods", label: "Periods", any: LEDGER },
    ["bank-accounts", "Bank accounts", 6], ["reconciliation", "Reconciliation", 6], ["assets", "Assets", 8], ["bas", "BAS", 7]] },
  { group: "Administration", items: [
    { path: "company", label: "Company settings" },
    { path: "users", label: "Users and roles", perm: "access.manage" },
    { path: "approvals", label: "Approvals", count: "approvals" },
    { path: "integrations", label: "Integrations" },
    { path: "audit", label: "Audit log", perm: "audit.view" }
  ] }
].map(g => ({ ...g, items: g.items.map(i => Array.isArray(i) ? { path: i[0], label: i[1], phase: i[2] } : i) }));

const VIEWS = {
  dashboard: renderDashboard, company: renderCompany, users: renderUsers, approvals: renderApprovals,
  integrations: renderIntegrations, audit: renderAudit, "chart-of-accounts": renderChart, "tax-codes": renderTaxCodes,
  journals: renderJournals, periods: renderPeriods, reports: renderReports,
  customers: renderCustomers, quotes: renderQuotes, invoices: renderInvoices, receipts: renderReceipts,
  suppliers: renderSuppliers, "purchase-orders": renderPurchaseOrders, bills: renderBills, "supplier-payments": renderSupplierPayments,
  projects: renderProjects, "job-costing": renderJobCosting, timesheets: renderTimesheets,
  employees: renderEmployees, "pay-runs": renderPayRuns, leave: renderLeave, super: renderSuper, "payroll-reports": renderPayrollReports, "my-pay": renderMyPay
};
const allowed = i => (!i.perm || can(i.perm)) && (!i.any || i.any.some(can));

/* ---------------- Gate and MFA ---------------- */

function gate(title, html) {
  $("[data-gate]").classList.remove("hidden");
  $("[data-shell]").classList.add("hidden");
  $("[data-gate-title]").textContent = title;
  $("[data-gate-body]").innerHTML = html;
}

function signInLink() {
  return `<p class="muted">Sign in on the Panalo portal with your email and password, then you'll come straight back here.</p>
    <a class="btn primary" href="../training/?next=${encodeURIComponent("/accounts/")}">Sign in</a>`;
}

async function showMfa() {
  const factors = await mfaFactors();
  const verified = factors.find(f => f.status === "verified");
  if (verified) {
    gate("Confirm it's you", `<p class="muted">Your access includes company finances, so Panalo Accounts asks for the 6-digit code from your authenticator app each time you sign in.</p>
      <form class="mfa" data-mfa-form data-factor="${safe(verified.id)}">
        <div class="fld"><label for="mfa-code">6-digit code</label><input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div>
        <button class="btn primary" type="submit">Verify</button></form>
      <p class="msg" data-mfa-msg role="status"></p>
      <p class="muted small">Lost your phone? Ask a Panalo administrator to reset your authenticator.</p>`);
  } else {
    const setup = await mfaEnroll();
    gate("Set up two-step sign-in", `<p class="muted">Your access includes company finances, so Panalo Accounts needs a second step at sign-in. This is required for administrators, directors, finance and payroll staff.</p>
      <ol class="steps">
        <li>Install an authenticator app on your phone, such as Microsoft Authenticator or Google Authenticator.</li>
        <li>In the app, add an account and scan this code.<div class="qr">${setup.qrCode ? `<img src="${safe(setup.qrCode)}" alt="QR code for your authenticator app" width="180" height="180">` : ""}</div>
          <small>Can't scan? Enter this key instead: <code class="secret">${safe(setup.secret || "")}</code></small></li>
        <li>Type the 6-digit code the app shows.</li></ol>
      <form class="mfa" data-mfa-form data-factor="${safe(setup.id)}">
        <div class="fld"><label for="mfa-code">6-digit code</label><input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div>
        <button class="btn primary" type="submit">Turn on two-step sign-in</button></form>
      <p class="msg" data-mfa-msg role="status"></p>`);
  }
  $("#mfa-code")?.focus();
}

document.addEventListener("submit", async event => {
  const form = event.target.closest("[data-mfa-form]");
  if (!form) return;
  event.preventDefault();
  const msg = $("[data-mfa-msg]");
  const button = form.querySelector("button");
  button.disabled = true;
  msg.textContent = "Checking…";
  try {
    await mfaVerify(form.dataset.factor, $("#mfa-code").value);
    await start();
  } catch (error) {
    msg.textContent = friendlyError(error);
    button.disabled = false;
  }
});

/* ---------------- Shell ---------------- */

let counts = { approvals: 0, timesheets: 0, payRuns: 0, leave: 0 };

function renderNav() {
  const current = (location.hash.replace(/^#\/?/, "") || "dashboard").split("?")[0].split("/")[0];
  $("[data-nav]").innerHTML = MENU.map(g => {
    const items = g.items.filter(allowed);
    if (!items.length) return "";
    return `<div class="nav-group">${g.group ? `<p class="nav-title">${safe(g.group)}</p>` : ""}
      ${items.map(i => `<a href="#/${i.path}" class="nav-item${i.path === current ? " active" : ""}${i.phase ? " later" : ""}" ${i.path === current ? 'aria-current="page"' : ""}>
        <span>${safe(i.label)}</span>${i.phase ? `<span class="tag">Phase ${i.phase}</span>` : ""}${i.count && counts[i.count] ? `<span class="count">${counts[i.count]}</span>` : ""}</a>`).join("")}</div>`;
  }).join("");
}

async function refreshCounts() {
  try {
    const [notes, approvals] = await Promise.all([call("notifications_list"), call("approvals_list")]);
    counts.approvals = approvals.toDecide.length;
    if (can("payroll.approve")) counts.payRuns = (await call("pay_runs_list")).runs.filter(r => r.status === "submitted").length;
    if (can("leave.approve")) counts.leave = (await call("leave_list", { status: "submitted" })).requests.filter(r => !r.mine).length;
    if (can("time.approve")) counts.timesheets = (await call("timesheets_review", { status: "submitted" })).timesheets.filter(t => !t.mine).length;
    const badge = $("[data-bell-count]");
    badge.textContent = String(notes.unread);
    badge.classList.toggle("hidden", !notes.unread);
    $("[data-notes]").innerHTML = `<div class="notes-head"><strong>Notifications</strong>${notes.unread ? '<button type="button" class="link" data-read-all>Mark all read</button>' : ""}</div>
      ${notes.items.length ? `<ul>${notes.items.map(n => `<li class="${n.read ? "" : "unread"}"><a href="#/${safe(n.link || "dashboard")}" data-note>${safe(n.title)}</a>
        <small>${safe(n.body)}${n.body ? " · " : ""}${dateTime(n.createdAt)}</small></li>`).join("")}</ul>` : '<p class="muted small">Nothing yet.</p>'}`;
    renderNav();
  } catch (_) { /* counts are a convenience */ }
}

async function route() {
  const full = (location.hash.replace(/^#\/?/, "") || "dashboard").split("?")[0];
  const [path, ...rest] = full.split("/");
  renderNav();
  // A fresh element per screen, so listeners from the last screen don't linger.
  const old = $("[data-view]");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  $("#app-msg").textContent = "";
  $("#app-msg").className = "msg";
  const item = MENU.flatMap(g => g.items.map(i => ({ ...i, group: g.group }))).find(i => i.path === path);
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (VIEWS[path] && (!item || allowed(item))) await VIEWS[path](view, { me: state.me, can, refreshCounts, sub: rest.join("/") });
    else if (item?.phase) renderPlanned(view, item);
    else { location.hash = "#/dashboard"; return; }
  } catch (error) {
    if (error?.code === "mfa_required") return showMfa();
    view.innerHTML = `<section class="panel"><h1>Something went wrong</h1><p class="msg bad">${safe(friendlyError(error))}</p></section>`;
  }
  $("#main").focus({ preventScroll: true });
}

async function start() {
  const me = await call("whoami");
  state.me = me;
  if (me.mfa.required && !me.mfa.satisfied) return showMfa();
  $("[data-gate]").classList.add("hidden");
  $("[data-shell]").classList.remove("hidden");
  $("[data-top]").classList.remove("hidden");
  $("[data-who]").textContent = me.name;
  $("[data-org]").textContent = me.organization?.name || "Panalo Pipes & Structurals";
  await route();
  refreshCounts();
}

async function init() {
  // Only sign-in redirects carry tokens in the hash; leave app links such as #/invoices/<id> alone.
  if (/(^|[#&])(access_token|error)=/.test(location.hash)) completeAuthRedirect();
  if (!isConfigured()) return gate("Not connected yet", '<p class="muted">The secure service has not been configured.</p>');
  if (!await getSession()) return gate("Sign in to Panalo Accounts", signInLink());
  try {
    await start();
  } catch (error) {
    if (error?.status === 401) return gate("Sign in to Panalo Accounts", signInLink());
    if (error?.code === "password_change_required") return gate("Change your temporary password first", '<p class="muted">You signed in with a temporary password. Choose your own on the portal, then come back.</p><a class="btn primary" href="../training/">Open the portal</a>');
    if (error?.code === "no_access") return gate("No access to Panalo Accounts", `<p class="muted">${safe(error.message)}</p><a class="btn" href="../training/">Back to the portal</a>`);
    gate("Panalo Accounts is unavailable", `<p class="msg bad">${safe(friendlyError(error))}</p>`);
  }
}

window.addEventListener("hashchange", () => {
  $("[data-notes]").classList.add("hidden");
  if (state.me) route();
});
document.addEventListener("click", async event => {
  if (event.target.closest("[data-signout]")) { await signOut(); location.assign("../training/"); return; }
  const bell = event.target.closest("[data-bell]");
  const panel = $("[data-notes]");
  if (bell) {
    const open = panel.classList.toggle("hidden") === false;
    bell.setAttribute("aria-expanded", String(open));
    return;
  }
  if (event.target.closest("[data-read-all]")) { await call("notifications_read").catch(() => null); refreshCounts(); return; }
  if (event.target.closest("[data-note]") || !event.target.closest("[data-notes]")) panel.classList.add("hidden");
});

// Exposed for screens that change counts (approvals decided, etc.).
export { refreshCounts, sessionAal };
init();
