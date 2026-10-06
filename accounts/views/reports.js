// Financial reports: profit and loss, balance sheet, trial balance and
// account transactions, aged receivables and payables, with drill-down and
// logged CSV export. Route: #/reports?type=pl|bs|tb|account|ar|ap&...
import { addMonths, call, date, downloadCsv, endOfMonth, flash, friendlyError, hashParams, money, options, safe, today, TYPE_LABEL, TYPE_ORDER } from "../lib/ui.js";

const TABS = [["pl", "Profit and loss"], ["bs", "Balance sheet"], ["tb", "Trial balance"], ["account", "Account transactions"], ["ar", "Aged receivables"], ["ap", "Aged payables"]];
const BUCKETS = [["current", "Current"], ["days30", "1–30 days"], ["days60", "31–60 days"], ["days90", "61–90 days"], ["over90", "Over 90 days"], ["credits", "Credits"], ["total", "Total"]];

export async function renderReports(view) {
  const setup = await call("ledger_setup");
  const p = hashParams();
  const t = today();
  const fyStart = setup.financialYearStart || `${Number(t.slice(5, 7)) >= 7 ? t.slice(0, 4) : Number(t.slice(0, 4)) - 1}-07-01`;
  const state = {
    type: TABS.some(x => x[0] === p.get("type")) ? p.get("type") : "pl",
    from: p.get("from") || fyStart, to: p.get("to") || t, asAt: p.get("asAt") || t,
    account: p.get("account") || setup.accounts.find(a => a.code === "1000")?.id || ""
  };
  const presets = [
    ["This month", `${t.slice(0, 7)}-01`, endOfMonth(t)],
    ["Last month", addMonths(t, -1), endOfMonth(addMonths(t, -1))],
    ["This financial year", fyStart, t],
    ["Last financial year", `${Number(fyStart.slice(0, 4)) - 1}${fyStart.slice(4)}`, new Date(Date.parse(fyStart) - 86400000).toISOString().slice(0, 10)]
  ];
  let data = null;

  const go = () => {
    const q = new URLSearchParams({ type: state.type });
    if (state.type === "pl" || state.type === "account") { q.set("from", state.from); q.set("to", state.to); }
    else q.set("asAt", state.asAt);
    if (state.type === "account") q.set("account", state.account);
    history.replaceState(null, "", `#/reports?${q}`);
  };

  const params = () => state.type === "pl" ? { kind: "profit_loss", from: state.from, to: state.to }
    : state.type === "bs" ? { kind: "balance_sheet", asAt: state.asAt }
    : state.type === "tb" ? { kind: "trial_balance", asAt: state.asAt }
    : state.type === "ar" ? { kind: "aged_receivables", asAt: state.asAt }
    : state.type === "ap" ? { kind: "aged_payables", asAt: state.asAt }
    : { kind: "account_transactions", accountId: state.account, from: state.from, to: state.to };

  const acctLink = (r, label) => `<a href="#/reports?type=account&account=${safe(r.accountId)}&from=${safe(state.type === "pl" ? state.from : fyStart)}&to=${safe(state.type === "pl" ? state.to : state.asAt)}">${label}</a>`;

  const body = () => {
    if (!data) return "";
    if (state.type === "pl") {
      const s = data.totals;
      const sec = (type, title) => {
        const rows = data.rows.filter(r => r.type === type);
        if (!rows.length) return "";
        return `<tr class="group"><th colspan="2" scope="colgroup">${safe(title)}</th></tr>${rows.map(r => `<tr><td>${acctLink(r, `<span class="mono">${safe(r.code)}</span> ${safe(r.name)}`)}</td><td class="num mono">${money(r.amount)}</td></tr>`).join("")}`;
      };
      return `<table class="tbl report"><tbody>
        ${sec("revenue", "Trading income")}<tr class="sub"><th scope="row">Total trading income</th><td class="num mono">${money(s.revenue)}</td></tr>
        ${sec("cost_of_sales", "Cost of sales")}<tr class="sub"><th scope="row">Total cost of sales</th><td class="num mono">${money(s.costOfSales)}</td></tr>
        <tr class="total"><th scope="row">Gross profit${s.grossMarginPercent != null ? ` <span class="muted small">(${s.grossMarginPercent}% margin)</span>` : ""}</th><td class="num mono">${money(s.grossProfit)}</td></tr>
        ${sec("expense", "Operating expenses")}<tr class="sub"><th scope="row">Total operating expenses</th><td class="num mono">${money(s.expenses)}</td></tr>
        ${sec("other_income", "Other income")}${sec("other_expense", "Other expenses")}
        <tr class="grand"><th scope="row">Net profit</th><td class="num mono">${money(s.netProfit)}</td></tr></tbody></table>`;
    }
    if (state.type === "bs") {
      const s = data.totals;
      const sec = (type, title) => `<tr class="group"><th colspan="2" scope="colgroup">${safe(title)}</th></tr>${data.rows.filter(r => r.type === type).map(r =>
        `<tr><td>${acctLink(r, `<span class="mono">${safe(r.code)}</span> ${safe(r.name)}`)}</td><td class="num mono">${money(r.amount)}</td></tr>`).join("")}`;
      return `<table class="tbl report"><tbody>
        ${sec("asset", "Assets")}<tr class="sub"><th scope="row">Total assets</th><td class="num mono">${money(s.assets)}</td></tr>
        ${sec("liability", "Liabilities")}<tr class="sub"><th scope="row">Total liabilities</th><td class="num mono">${money(s.liabilities)}</td></tr>
        <tr class="total"><th scope="row">Net assets</th><td class="num mono">${money(s.netAssets)}</td></tr>
        ${sec("equity", "Equity")}
        <tr><td>Retained earnings (prior years)</td><td class="num mono">${money(data.retainedEarningsPriorYears)}</td></tr>
        <tr><td>Current year earnings</td><td class="num mono">${money(data.currentYearEarnings)}</td></tr>
        <tr class="grand"><th scope="row">Total equity</th><td class="num mono">${money(s.equity)}</td></tr></tbody></table>
        <p class="balance ${s.balanced ? "good" : "bad"}">${s.balanced ? "Balanced: net assets equal total equity." : "Out of balance: tell your administrator."}</p>`;
    }
    if (state.type === "ar" || state.type === "ap") {
      const ar = state.type === "ar";
      return `<table class="tbl report"><thead><tr><th scope="col">${ar ? "Customer" : "Supplier"}</th>${BUCKETS.map(([, l]) => `<th scope="col" class="num">${l}</th>`).join("")}</tr></thead><tbody>
        ${data.rows.map(r => `<tr><td><a href="#/${ar ? "customers" : "suppliers"}/${safe(ar ? r.customerId : r.supplierId)}">${safe(r.name)}</a></td>
          ${BUCKETS.map(([k]) => `<td class="num mono ${["days60", "days90", "over90"].includes(k) && Number(r[k]) > 0 ? "bad-text" : ""}">${money(r[k], { blankZero: k !== "total" })}</td>`).join("")}</tr>`).join("")
          || `<tr><td colspan="8" class="muted">Nothing ${ar ? "owed to Panalo" : "owing to suppliers"} at this date.</td></tr>`}
        </tbody><tfoot><tr class="grand"><th scope="row">Total</th>${BUCKETS.map(([k]) => `<td class="num mono">${money(data.totals[k])}</td>`).join("")}</tr></tfoot></table>
        <p class="muted small">Days past the due date. ${ar ? "Credits are unapplied credit notes and payments." : "Credits are unapplied supplier credits."} The total agrees with the ${ar ? "Accounts Receivable (1100)" : "Accounts Payable (2000)"} balance at the same date.</p>`;
    }
    if (state.type === "tb") {
      return `<table class="tbl report"><thead><tr><th scope="col">Account</th><th scope="col">Type</th><th scope="col" class="num">Debit</th><th scope="col" class="num">Credit</th></tr></thead><tbody>
        ${data.rows.map(r => `<tr><td>${acctLink(r, `<span class="mono">${safe(r.code)}</span> ${safe(r.name)}`)}</td><td class="muted">${safe(TYPE_LABEL[r.type])}</td>
          <td class="num mono">${money(r.debit, { blankZero: true })}</td><td class="num mono">${money(r.credit, { blankZero: true })}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No balances.</td></tr>'}
        </tbody><tfoot><tr class="grand"><th scope="row" colspan="2">Total</th><td class="num mono">${money(data.totalDebit)}</td><td class="num mono">${money(data.totalCredit)}</td></tr></tfoot></table>
        <p class="muted small">Profit and loss accounts show this financial year (from ${date(data.financialYearStart)}); earlier years are included in retained earnings.</p>`;
    }
    let running = Number(data.openingBalance);
    const sign = data.account.normalSide === "credit" ? -1 : 1;
    return `<table class="tbl report"><thead><tr><th scope="col">Date</th><th scope="col">Journal</th><th scope="col">Details</th><th scope="col" class="num">Debit</th><th scope="col" class="num">Credit</th><th scope="col" class="num">Balance</th></tr></thead><tbody>
      <tr class="sub"><td>${date(data.from)}</td><td colspan="4">Opening balance</td><td class="num mono">${money(sign * running)}</td></tr>
      ${data.rows.map(r => { running += Number(r.debit) - Number(r.credit); return `<tr><td class="nowrap">${date(r.date)}</td>
        <td class="mono"><a href="#/journals/${safe(r.journalId)}">${safe(r.number)}</a></td><td>${safe(r.description || r.memo)}${r.taxCode ? ` <span class="muted small">${safe(r.taxCode)}</span>` : ""}</td>
        <td class="num mono">${money(r.debit, { blankZero: true })}</td><td class="num mono">${money(r.credit, { blankZero: true })}</td><td class="num mono">${money(sign * running)}</td></tr>`; }).join("")}
      </tbody><tfoot><tr class="grand"><th scope="row" colspan="5">Closing balance</th><td class="num mono">${money(sign * Number(data.closingBalance))}</td></tr></tfoot></table>
      <p class="muted small">Balances shown as ${data.account.normalSide === "credit" ? "credits" : "debits"}, the normal side for this account; bracketed figures are the other way.</p>`;
  };

  const csv = () => {
    if (state.type === "pl") return [["Account code", "Account", "Type", "Amount"], ...data.rows.map(r => [r.code, r.name, TYPE_LABEL[r.type], r.amount]),
      [], ["", "Gross profit", "", data.totals.grossProfit], ["", "Net profit", "", data.totals.netProfit]];
    if (state.type === "bs") return [["Account code", "Account", "Type", "Amount"], ...data.rows.map(r => [r.code, r.name, TYPE_LABEL[r.type], r.amount]),
      ["", "Retained earnings (prior years)", "Equity", data.retainedEarningsPriorYears], ["", "Current year earnings", "Equity", data.currentYearEarnings],
      [], ["", "Total assets", "", data.totals.assets], ["", "Total liabilities", "", data.totals.liabilities], ["", "Total equity", "", data.totals.equity]];
    if (state.type === "ar" || state.type === "ap") return [[state.type === "ar" ? "Customer" : "Supplier", ...BUCKETS.map(b => b[1])], ...data.rows.map(r => [r.name, ...BUCKETS.map(([k]) => r[k])]), ["Total", ...BUCKETS.map(([k]) => data.totals[k])]];
    if (state.type === "tb") return [["Account code", "Account", "Type", "Debit", "Credit"], ...data.rows.map(r => [r.code, r.name, TYPE_LABEL[r.type], r.debit, r.credit]), ["", "Total", "", data.totalDebit, data.totalCredit]];
    return [["Date", "Journal", "Details", "Tax", "Debit", "Credit"], ["", "", "Opening balance", "", "", data.openingBalance], ...data.rows.map(r => [r.date, r.number, r.description || r.memo, r.taxCode || "", r.debit, r.credit])];
  };

  const draw = () => {
    const ranged = state.type === "pl" || state.type === "account";
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING · REPORTS</p><h1>${safe(TABS.find(x => x[0] === state.type)[1])}</h1>
        <p class="muted">${safe(data ? (ranged ? `${date(state.from)} to ${date(state.to)}` : `As at ${date(state.asAt)}`) : "")}${data?.account ? ` · ${safe(data.account.code)} ${safe(data.account.name)}` : ""}</p></div>
        ${setup.can.export && data ? '<button class="btn" type="button" data-csv>Export CSV</button>' : ""}</header>
      <nav class="tabs" aria-label="Reports">${TABS.map(([k, l]) => `<button type="button" class="${k === state.type ? "on" : ""}" data-tab="${k}" ${k === state.type ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
      <section class="panel">
        <form class="toolbar" data-run>
          ${state.type === "account" ? `<div class="fld"><label for="r-acc">Account</label><select id="r-acc">${TYPE_ORDER.map(ty => {
            const rows = setup.accounts.filter(a => a.type === ty);
            return rows.length ? `<optgroup label="${safe(TYPE_LABEL[ty])}">${rows.map(a => `<option value="${safe(a.id)}" ${a.id === state.account ? "selected" : ""}>${safe(a.code)} ${safe(a.name)}</option>`).join("")}</optgroup>` : "";
          }).join("")}</select></div>` : ""}
          ${ranged ? `<div class="fld"><label for="r-from">From</label><input id="r-from" type="date" value="${safe(state.from)}"></div>
            <div class="fld"><label for="r-to">To</label><input id="r-to" type="date" value="${safe(state.to)}"></div>
            <div class="fld"><label for="r-pre">Quick range</label><select id="r-pre">${options([["", "Choose…"], ...presets.map((x, i) => [String(i), x[0]])], "")}</select></div>`
            : `<div class="fld"><label for="r-asat">As at</label><input id="r-asat" type="date" value="${safe(state.asAt)}"></div>`}
          <button class="btn primary" type="submit">Run report</button></form>
        <div class="tbl-wrap">${body()}</div>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };

  const run = async () => {
    go();
    data = await call("report", params());
    draw();
  };

  try { await run(); } catch (error) { draw(); flash(view, friendlyError(error), "bad"); }

  view.addEventListener("change", e => {
    if (e.target.id === "r-pre" && e.target.value !== "") {
      const [, from, to] = presets[Number(e.target.value)];
      view.querySelector("#r-from").value = from;
      view.querySelector("#r-to").value = to;
    }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-run]")) return;
    e.preventDefault();
    const v = id => view.querySelector(`#${id}`)?.value;
    if (v("r-from")) state.from = v("r-from");
    if (v("r-to")) state.to = v("r-to");
    if (v("r-asat")) state.asAt = v("r-asat");
    if (v("r-acc")) state.account = v("r-acc");
    try { await run(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      state.type = tab.dataset.tab;
      data = null;
      try { await run(); } catch (error) { draw(); flash(view, friendlyError(error), "bad"); }
      return;
    }
    if (e.target.closest("[data-csv]")) {
      try {
        data = await call("report_export", params());
        const name = `${TABS.find(x => x[0] === state.type)[1].toLowerCase().replace(/\s+/g, "-")}-${state.type === "pl" || state.type === "account" ? `${state.from}-to-${state.to}` : state.asAt}.csv`;
        downloadCsv(name, csv());
        flash(view, "Exported. Exports are recorded in the audit log.", "good");
      } catch (error) { flash(view, friendlyError(error), "bad"); }
    }
  });
}
