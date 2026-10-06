import { safe } from "../lib/ui.js";

const WHAT = {
  2: "the accounting core: chart of accounts, GST tax codes, journals, the posting engine, accounting periods, trial balance, profit and loss, and balance sheet",
  3: "sales and purchasing: customers, suppliers, quotes, invoices, purchase orders, bills, receivables and payables",
  4: "projects: projects, cost codes, digital timesheets with supervisor approval, labour and materials costing, and project profitability",
  5: "payroll: employee pay settings, PAYG withholding, Payday Super, leave, pay runs, payslips and payroll journals",
  6: "banking: bank statement import (CSV, OFX), matching suggestions, bank rules and reconciliation",
  7: "BAS: GST and PAYG reconciliation, the BAS workpaper and the taxable payments annual report",
  8: "STP Phase 2 data, validation and exports, and the fixed asset register"
};

export function renderPlanned(view, item) {
  view.innerHTML = `<section class="panel planned">
    <p class="eyebrow">${safe((item.group || "").toUpperCase())}</p><h1>${safe(item.label)}</h1>
    <p><span class="chip info">Arrives in Phase ${item.phase}</span></p>
    <p class="muted">This screen is part of Phase ${item.phase}: ${safe(WHAT[item.phase] || "a later phase")}. Each phase is built, tested and reviewed before the next starts, and every money movement will post through the same double-entry ledger.</p>
    <a class="btn" href="#/dashboard">Back to the dashboard</a></section>`;
}
