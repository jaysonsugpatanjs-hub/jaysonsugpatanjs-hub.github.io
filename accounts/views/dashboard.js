import { call, date, money, safe } from "../lib/ui.js";
import { formatAbn } from "../lib/validate.js";

const ROADMAP = [
  [1, "Foundation", "Company setup, roles, two-step sign-in, approvals, audit log"],
  [2, "Accounting core", "Chart of accounts, tax codes, journals, posting engine, trial balance, P&L, balance sheet"],
  [3, "Sales and purchasing", "Customers, suppliers, quotes, invoices, purchase orders, bills"],
  [4, "Projects", "Projects, cost codes, timesheets, job costing"],
  [5, "Payroll", "Pay settings, PAYG, super, leave, pay runs, payslips"],
  [6, "Banking", "Bank import, matching, rules, reconciliation"],
  [7, "BAS", "GST and PAYG reconciliation, BAS workpaper, TPAR"],
  [8, "STP and assets", "STP Phase 2 data and exports, fixed assets"],
  [9, "Hardening", "Security review, backups, restore tests, user acceptance"]
];

export async function renderDashboard(view, { can }) {
  const d = await call("dashboard");
  const setupDone = d.setup.complete;
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">DASHBOARD</p><h1>${safe(d.company.tradingName || d.company.legalName || "Panalo Accounts")}</h1>
      <p class="muted">${safe(d.company.legalName || "")}${d.company.abn ? ` · ABN ${safe(formatAbn(d.company.abn))}` : ""}</p></div>
      ${d.company.logoUrl ? `<img class="logo" src="${safe(d.company.logoUrl)}" alt="Company logo">` : ""}</header>

    ${d.ledger ? `<div class="cards figures">
      <section class="card"><h2>Bank</h2><p class="big mono">${money(d.ledger.bank)}</p><p class="muted small">Bank accounts in the ledger, as at ${date(d.ledger.asAt)}</p><a class="link" href="#/reports?type=account">Transactions</a></section>
      <section class="card"><h2>Net profit this financial year</h2><p class="big mono">${money(d.ledger.netProfitYearToDate)}</p><p class="muted small">From ${date(d.ledger.financialYearStart)}</p><a class="link" href="#/reports?type=pl">Profit and loss</a></section>
      <section class="card"><h2>GST owed (estimate)</h2><p class="big mono">${money(d.ledger.gstOwed)}</p><p class="muted small">Balance of the GST account; bracketed means a refund is due</p></section>
      <section class="card ${d.ledger.draftJournals ? "attention" : ""}"><h2>Draft journals</h2><p class="big">${d.ledger.draftJournals}</p><p class="muted small">Not in the ledger until posted</p><a class="link" href="#/journals?status=draft">Review drafts</a></section>
    </div>` : ""}
    ${d.sales || d.purchases ? `<div class="cards figures">
      ${d.sales ? `<section class="card"><h2>Customers owe</h2><p class="big mono">${money(d.sales.owed)}</p><p class="muted small">${d.sales.overdue ? `${money(d.sales.overdue)} overdue` : "Nothing overdue"}</p><a class="link" href="#/reports?type=ar">Aged receivables</a></section>
      <section class="card ${d.sales.draftInvoices ? "attention" : ""}"><h2>Draft invoices</h2><p class="big">${d.sales.draftInvoices}</p><p class="muted small">Not sent or posted until approved</p><a class="link" href="#/invoices?view=draft">Review</a></section>` : ""}
      ${d.purchases ? `<section class="card"><h2>Panalo owes suppliers</h2><p class="big mono">${money(d.purchases.owing)}</p><p class="muted small">${d.purchases.overdue ? `${money(d.purchases.overdue)} overdue` : "Nothing overdue"}</p><a class="link" href="#/reports?type=ap">Aged payables</a></section>
      <section class="card ${d.purchases.billsToReview || d.purchases.ordersToApprove ? "attention" : ""}"><h2>Waiting on purchasing</h2><p class="big">${d.purchases.billsToReview + d.purchases.ordersToApprove}</p>
        <p class="muted small">${d.purchases.billsToReview} bill${d.purchases.billsToReview === 1 ? "" : "s"} to review · ${d.purchases.ordersToApprove} order${d.purchases.ordersToApprove === 1 ? "" : "s"} to approve</p><a class="link" href="#/bills?view=draft">Bills</a> · <a class="link" href="#/purchase-orders">Orders</a></section>` : ""}
    </div>` : ""}
    <div class="cards">
      <section class="card ${setupDone ? "" : "attention"}">
        <h2>Company setup</h2>
        ${setupDone
          ? '<p class="big good">Complete</p><p class="muted small">Change details any time in Company settings.</p>'
          : `<p class="big">${6 - d.setup.missing.length} of 6</p><p class="muted small">Still needed: ${safe(d.setup.missing.join(", "))}.</p>`}
        <a class="btn ${setupDone ? "" : "primary"}" href="#/company">${setupDone ? "View settings" : d.setup.canEdit ? "Continue setup" : "View settings"}</a>
      </section>
      <section class="card ${d.approvalsWaiting ? "attention" : ""}">
        <h2>Approvals waiting for you</h2>
        <p class="big">${d.approvalsWaiting}</p>
        <p class="muted small">${d.myPending ? `${d.myPending} of your own requests waiting for someone else.` : "Changes that need a second person, such as new bank accounts."}</p>
        <a class="btn" href="#/approvals">Open approvals</a>
      </section>
      <section class="card">
        <h2>Notifications</h2>
        <p class="big">${d.unread}</p><p class="muted small">unread</p>
      </section>
    </div>

    <section class="panel">
      <h2>What's being built</h2>
      <p class="muted">Panalo Accounts is delivered in phases, each tested before the next starts. Menu items marked with a phase arrive then.</p>
      <table class="tbl"><thead><tr><th scope="col">Phase</th><th scope="col">Module</th><th scope="col">Includes</th><th scope="col">Status</th></tr></thead><tbody>
        ${ROADMAP.map(([n, name, inc]) => `<tr><td>${n}</td><td><strong>${safe(name)}</strong></td><td class="muted">${safe(inc)}</td><td>${n <= 3 ? '<span class="chip good">Live</span>' : n === 4 ? '<span class="chip info">Next</span>' : '<span class="chip">Planned</span>'}</td></tr>`).join("")}
      </tbody></table>
    </section>
    ${can("audit.view") ? '<p class="muted small">Every change in Panalo Accounts is recorded in the <a href="#/audit">audit log</a>.</p>' : ""}`;
}
