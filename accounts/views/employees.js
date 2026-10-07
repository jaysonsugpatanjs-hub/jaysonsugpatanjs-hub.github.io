// Payroll employees. Routes: #/employees, #/employees/<id>
// Pay, tax and super details need "Payroll: pay, tax and bank details".
// TFNs and bank account numbers are only ever shown masked; bank changes go
// to a second person for approval.
import { call, chip, clearErrors, date, field, fieldError, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";
import { formatBsb, validAccountNumber, validBsb, validTfn } from "../lib/validate.js";
import { readStpDetails, stpDetailsForm } from "./stp.js";

export const BASIS = { full_time: "Full-time", part_time: "Part-time", casual: "Casual" };
const FREQ = [["weekly", "Weekly"], ["fortnightly", "Fortnightly"], ["monthly", "Monthly"]];
const KIND = { accrual: "Accrued", taken: "Taken", adjustment: "Adjustment", opening: "Opening balance" };

export async function renderEmployees(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id) return detail(view, id, ctx);
  return list(view, ctx);
}

async function list(view, ctx) {
  const f = { show: "payroll", q: "" };
  const load = async () => {
    const d = await call("payroll_employees", f);
    const rows = d.employees.filter(e => !f.q || e.name.toLowerCase().includes(f.q.toLowerCase()));
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL</p><h1>Employees</h1>
        <p class="muted">People in the HR register who are paid through payroll. Set up each person's pay, tax declaration, super fund and bank account before their first pay run. Contractors are paid through bills.</p></div></header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="em-q">Name</label><input id="em-q" value="${safe(f.q)}"></div>
          <div class="fld"><label for="em-show">Show</label><select id="em-show">${options([["payroll", "Active and in payroll"], ["all", "Everyone in the HR register"]], f.show)}</select></div>
          <button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Employee</th><th scope="col">Position</th><th scope="col">Basis</th><th scope="col">Paid</th>
          ${ctx.can("payroll.sensitive") ? '<th scope="col" class="num">Rate</th>' : ""}<th scope="col">Needs attention</th></tr></thead><tbody>
          ${rows.map(e => `<tr><td><a href="#/employees/${safe(e.id)}">${safe(e.name)}</a><small>${safe(e.number)}${e.hrStatus !== "active" ? ` · ${safe(e.hrStatus)}` : ""}</small></td>
            <td>${safe(e.position || "—")}</td><td>${e.inPayroll ? safe(BASIS[e.basis] || "") : chip("Not set up", "pending")}${e.status === "terminated" ? ` ${chip("Finished")}` : ""}</td>
            <td>${safe(FREQ.find(x => x[0] === e.frequency)?.[1] || "—")}</td>
            ${ctx.can("payroll.sensitive") ? `<td class="num mono">${e.inPayroll ? (e.payBasis === "salary" ? `${money(e.annualSalary)} pa` : `${money(e.hourlyRate)}/h`) : ""}</td>` : ""}
            <td>${e.problems.map(p => `<small class="warn-text">${safe(p)}</small>`).join("") || '<span class="muted small">—</span>'}</td></tr>`).join("")
            || '<tr><td colspan="6" class="muted">Nobody here. Add people in the HR register on the portal first.</td></tr>'}
        </tbody></table></div></section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    f.q = view.querySelector("#em-q").value.trim();
    f.show = view.querySelector("#em-show").value;
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function detail(view, id, ctx) {
  const setup = await call("payroll_setup");
  let suggested = null;
  const load = async () => {
    const d = await call("payroll_employee_get", { id });
    const e = d.employee, p = d.pay || {}, s = suggested || {};
    const v = (k, fallback = "") => (s[k] !== undefined && s[k] !== null ? s[k] : p[k] ?? fallback);
    const sens = d.can.edit;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PAYROLL · EMPLOYEES</p><h1>${safe(e.name)} ${d.inPayroll ? chip(BASIS[p.basis] || "In payroll", "good") : chip("Not set up yet", "pending")}</h1>
        <p class="muted">${safe(e.number)}${e.position ? ` · ${safe(e.position)}` : ""}${e.hrStart ? ` · started ${date(e.hrStart)}` : ""}${e.linked ? "" : " · no portal account (can't see their own payslips)"}</p></div></header>
      ${d.problems.length && e.hrStatus === "active" ? `<p class="note">${d.problems.map(safe).join(" · ")}</p>` : ""}
      ${sens ? `
      <form class="panel" data-pay novalidate>
        <div class="head-row"><h2>Pay</h2><button type="button" class="btn" data-import>Fill in from onboarding</button></div>
        ${suggested?._found ? `<p class="note small">Filled in from their accepted onboarding forms (${safe(suggested._found)}). Check, then save. ${suggested.bank ? "Bank details from onboarding go to approval separately, below." : ""}</p>` : ""}
        <div class="grid3">
          <div class="fld"><label for="py-basis">Employment</label><select id="py-basis">${options(Object.entries(BASIS), v("basis", "full_time"))}</select></div>
          <div class="fld"><label for="py-paybasis">Paid by</label><select id="py-paybasis">${options([["hourly", "Hourly rate (hours from timesheets)"], ["salary", "Annual salary"]], v("payBasis", "hourly"))}</select></div>
          <div class="fld"><label for="py-freq">Pay frequency</label><select id="py-freq">${options(FREQ, v("frequency", setup.payFrequency))}</select></div>
          ${field({ id: "py-rate", label: "Base hourly rate ($)", value: p.hourlyRate || "", attrs: 'inputmode="decimal"', hint: `Before casual loading. National minimum ${money(setup.rules.nationalMinimumWage)}/h; the award minimum is usually higher.` })}
          ${field({ id: "py-salary", label: "Annual salary ($)", value: p.annualSalary || "", attrs: 'inputmode="decimal"' })}
          ${field({ id: "py-hours", label: "Ordinary hours a week", value: p.ordinaryHours ?? 38, attrs: 'inputmode="decimal"' })}
          ${field({ id: "py-casual", label: "Casual loading %", value: p.casualLoading ?? 25, attrs: 'inputmode="decimal"' })}
          ${field({ id: "py-loading", label: "Annual leave loading %", value: p.leaveLoading ?? 17.5, attrs: 'inputmode="decimal"' })}
          <div class="fld"><label for="py-alw">Annual leave a year</label><select id="py-alw">${options([["4", "4 weeks"], ["5", "5 weeks (shift worker)"]], String(p.annualLeaveWeeks ?? 4))}</select></div>
          ${field({ id: "py-award", label: "Award or agreement", value: p.award || "", attrs: 'maxlength="200"', hint: "For example: Manufacturing and Associated Industries and Occupations Award 2020" })}
          ${field({ id: "py-class", label: "Classification", value: p.classification || "", attrs: 'maxlength="120"' })}
          <div class="fld"><label for="py-acc">Wages account</label><select id="py-acc">${options(setup.wagesAccounts.map(a => [a.id, `${a.code} ${a.name}`]), p.wagesAccountId || setup.wagesAccounts.find(a => a.code === "5000")?.id)}</select></div>
          ${field({ id: "py-dob", label: "Date of birth", value: v("dateOfBirth"), type: "date", hint: "Under 18s working 30 hours a week or less don't get super guarantee" })}
          ${field({ id: "py-start", label: "Payroll start date", value: p.startDate || e.hrStart || "", type: "date" })}
          ${field({ id: "py-end", label: "Finish date", value: p.endDate || "", type: "date" })}
        </div>
        <h3>Tax declaration</h3>
        <div class="grid3">
          <div class="fld"><label for="py-tfns">TFN</label><select id="py-tfns">${options([["provided", "Provided"], ["applied", "Applied for (28 days, then 47%)"], ["exempt", "Exempt (under 18 or on a pension)"], ["not_provided", "Not provided: withhold 47%"]], v("tfnStatus", "not_provided"))}</select></div>
          ${field({ id: "py-tfn", label: s.tfnFromOnboarding ? `TFN from onboarding ${s.tfnMasked}` : p.tfn ? `TFN on file ${p.tfn}` : "Tax file number", value: "", attrs: 'inputmode="numeric" maxlength="11" autocomplete="off"',
            hint: s.tfnFromOnboarding ? "Leave blank to save the onboarding TFN; type one to use it instead" : p.tfn ? "Leave blank to keep it; type a new one to replace it" : "9 digits" })}
          <div class="fld"><label for="py-res">Residency</label><select id="py-res">${options([["resident", "Australian resident for tax"], ["foreign", "Foreign resident"], ["working_holiday", "Working holiday maker"]], v("residency", "resident"))}</select></div>
          <div class="fld"><label for="py-tft">Tax-free threshold</label><select id="py-tft">${options([["yes", "Claimed from Panalo"], ["no", "Not claimed"]], v("taxFreeThreshold", true) ? "yes" : "no")}</select></div>
          <div class="fld"><label for="py-stsl">Study or training loan</label><select id="py-stsl">${options([["no", "No"], ["yes", "Yes (HELP, VSL, SFSS, SSL or TSL)"]], v("studyLoan", false) ? "yes" : "no")}</select></div>
          <div class="fld"><label for="py-med">Medicare levy</label><select id="py-med">${options([["none", "No variation"], ["half", "Half exemption claimed"], ["full", "Full exemption claimed"]], p.medicareExemption || "none")}</select></div>
          ${field({ id: "py-extra", label: "Extra tax each pay ($)", value: p.extraWithholding || "", attrs: 'inputmode="decimal"', hint: "Only if they asked for more tax to be taken" })}
        </div>
        <h3>Super</h3>
        <div class="grid3">
          ${field({ id: "py-fund", label: "Fund name", value: v("fundName"), attrs: 'maxlength="120"' })}
          ${field({ id: "py-usi", label: "Fund USI", value: v("fundUsi"), attrs: 'maxlength="20"', hint: "SMSF? Leave blank and enter its ABN" })}
          ${field({ id: "py-fundabn", label: "SMSF ABN", value: p.fundAbn || "", attrs: 'maxlength="14"' })}
          ${field({ id: "py-member", label: "Member number", value: v("memberNumber"), attrs: 'maxlength="30"' })}
          ${field({ id: "py-ss", label: "Salary sacrifice to super each pay ($)", value: p.salarySacrifice || "", attrs: 'inputmode="decimal"' })}
        </div>
        ${s.defaultFund ? '<p class="note small">They chose Panalo\'s default fund. If they have an existing fund, the ATO\'s stapled fund rules may apply: check before their first super payment.</p>' : ""}
        <div class="fld"><label for="py-notes">Notes</label><textarea id="py-notes" rows="2" maxlength="2000">${safe(p.notes || "")}</textarea></div>
        <label class="check"><input type="checkbox" id="py-term" ${p.status === "terminated" ? "checked" : ""}> Finished: no longer paid</label>
        <div class="actions"><button class="btn primary" type="submit">${d.inPayroll ? "Save pay details" : "Set up in payroll"}</button></div>
      </form>
      ${d.inPayroll && sens ? stpDetailsForm({ ...p, stp: { ...(p.stp || {}), homeAddress: s.homeAddress && !(p.stp?.homeAddress?.street) ? s.homeAddress : p.stp?.homeAddress } }, sens) : ""}
      ${d.inPayroll ? `<section class="panel"><h2>Bank account</h2>
        ${p.bank ? `<p class="mono">${safe(p.bank.accountName || "")} · BSB ${safe(p.bank.bsb)} · ${safe(p.bank.accountNumber)}</p><p class="muted small">Approved ${date(p.bank.changedAt)}</p>` : '<p class="muted">No bank account yet.</p>'}
        ${p.bankChangePending ? `<p>${chip("Change waiting for approval", "pending")}</p>` : `
        <form data-bank novalidate><div class="grid3">
          ${field({ id: "bk-name", label: "Account name", value: s.bank?.accountName || "", attrs: 'maxlength="120"' })}
          ${field({ id: "bk-bsb", label: "BSB", value: s.bank?.bsb ? formatBsb(s.bank.bsb) : "", attrs: 'inputmode="numeric" maxlength="7"' })}
          ${field({ id: "bk-acct", label: s.bank?.fromOnboarding ? `Account number (onboarding ${s.bank.accountNumber})` : "Account number", value: "", attrs: 'inputmode="numeric" maxlength="12" autocomplete="off"',
            hint: s.bank?.fromOnboarding ? "Leave blank to use the account from onboarding" : "" })}</div>
          <p class="muted small">Confirm new bank details with the employee in person or on a number you already have. Someone with "Approve pay runs" approves the change; nobody can approve their own.</p>
          <div class="actions"><button class="btn" type="submit">${p.bank ? "Request a change" : "Request approval"}</button></div></form>`}</section>` : ""}` : `<section class="panel"><p class="muted">Pay, tax, super and bank details are only shown to people with "Payroll: pay, tax and bank details".</p></section>`}
      ${d.inPayroll ? `<section class="panel"><h2>Leave</h2>
        <div class="cards figures">${d.leave.filter(l => l.paid && (l.balance !== 0 || ["ANNUAL", "PERSONAL"].includes(l.code))).map(l => `<section class="card"><h2>${safe(l.name)}</h2><p class="big mono">${l.balance.toLocaleString("en-AU", { maximumFractionDigits: 2 })} h</p>
          <p class="muted small">≈ ${(l.balance / ((p.ordinaryHours || 38) / 5)).toLocaleString("en-AU", { maximumFractionDigits: 1 })} days</p></section>`).join("")}</div>
        ${d.can.adjust ? `<form class="toolbar" data-adjust><div class="fld"><label for="la-type">Type</label><select id="la-type">${options(d.leave.map(l => [l.id, l.name]))}</select></div>
          <div class="fld"><label for="la-kind">Kind</label><select id="la-kind">${options([["opening", "Opening balance"], ["adjustment", "Adjustment"]])}</select></div>
          <div class="fld"><label for="la-hours">Hours (+/−)</label><input id="la-hours" inputmode="decimal"></div>
          <div class="fld"><label for="la-date">Date</label><input id="la-date" type="date" value="${today()}"></div>
          <div class="fld wide"><label for="la-note">Reason</label><input id="la-note" maxlength="300" placeholder="For example: balance from the previous payroll system"></div>
          <button class="btn" type="submit">Record</button></form>` : ""}
        ${d.leaveHistory.length ? `<details><summary>History</summary><table class="tbl"><tbody>${d.leaveHistory.map(t => `<tr><td>${date(t.date)}</td><td>${safe(d.leave.find(l => l.id === t.typeId)?.name || "")}</td>
          <td>${safe(KIND[t.kind] || t.kind)}</td><td class="num mono">${t.hours > 0 ? "+" : ""}${t.hours.toLocaleString("en-AU", { maximumFractionDigits: 4 })}</td><td class="muted small">${safe(t.note)}</td></tr>`).join("")}</tbody></table></details>` : ""}
      </section>` : ""}
      ${d.payHistory.length ? `<section class="panel"><h2>Pay history</h2><table class="tbl"><thead><tr><th scope="col">Pay run</th><th scope="col">Paid</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Tax</th><th scope="col" class="num">Super</th><th scope="col" class="num">Net</th><th scope="col"></th></tr></thead><tbody>
        ${d.payHistory.map(h => `<tr><td class="mono"><a href="#/pay-runs/${safe(h.runId)}">${safe(h.number)}</a></td><td>${date(h.paymentDate)}</td><td class="num mono">${money(h.gross)}</td><td class="num mono">${money(h.payg)}</td>
          <td class="num mono">${money(h.super)}</td><td class="num mono">${money(h.net)}</td><td><button type="button" class="link" data-slip="${safe(h.runId)}">Payslip</button></td></tr>`).join("")}</tbody></table></section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    try {
      if (e.target.closest("[data-import]")) {
        const r = await call("payroll_import_onboarding", { id });
        if (!r.found.length) return flash(view, "No accepted onboarding forms with tax, super, personal or bank details were found for this person.", "warn");
        suggested = { ...r.suggested, _found: r.found.join(", ").replace(/_/g, " ") };
        await load();
        return;
      }
      const slip = e.target.closest("[data-slip]");
      if (slip) { const { downloadPdf } = await import("../lib/docs.js"); await downloadPdf("payslip_pdf", { id: slip.dataset.slip, employeeId: id }); }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    clearErrors(view);
    const v = x => view.querySelector(`#${x}`)?.value.trim() ?? "";
    try {
      if (e.target.matches("[data-pay]")) {
        if (v("py-tfn") && !validTfn(v("py-tfn"))) return fieldError(view, "py-tfn", "That TFN isn't valid. Check the digits.");
        if (v("py-paybasis") === "hourly" && !(Number(v("py-rate")) > 0)) return fieldError(view, "py-rate", "Enter the base hourly rate.");
        if (v("py-paybasis") === "salary" && !(Number(v("py-salary").replace(/[$,]/g, "")) > 0)) return fieldError(view, "py-salary", "Enter the annual salary.");
        await call("payroll_employee_save", { id, basis: v("py-basis"), payBasis: v("py-paybasis"), frequency: v("py-freq"), hourlyRate: v("py-rate"), annualSalary: v("py-salary"),
          ordinaryHours: v("py-hours"), casualLoading: v("py-casual"), leaveLoading: v("py-loading"), annualLeaveWeeks: v("py-alw"), award: v("py-award"), classification: v("py-class"),
          wagesAccountId: v("py-acc"), dateOfBirth: v("py-dob"), startDate: v("py-start"), endDate: v("py-end"), tfnStatus: v("py-tfns"), tfn: v("py-tfn"), tfnFromOnboarding: Boolean(suggested?.tfnFromOnboarding) && !v("py-tfn"), residency: v("py-res"),
          taxFreeThreshold: v("py-tft") === "yes", studyLoan: v("py-stsl") === "yes", medicareExemption: v("py-med"), extraWithholding: v("py-extra"),
          fundName: v("py-fund"), fundUsi: v("py-usi"), fundAbn: v("py-fundabn"), memberNumber: v("py-member"), salarySacrifice: v("py-ss"), notes: v("py-notes"),
          status: view.querySelector("#py-term").checked ? "terminated" : "active" });
        const { bank, homeAddress } = suggested || {};
        suggested = bank || homeAddress ? { ...(bank ? { bank } : {}), ...(homeAddress ? { homeAddress } : {}) } : null;
        await load();
        flash(view, "Pay details saved.", "good");
      } else if (e.target.matches("[data-stp]")) {
        await call("payroll_employee_stp_save", { id, ...readStpDetails(view) });
        await load();
        flash(view, "STP details saved.", "good");
      } else if (e.target.matches("[data-bank]")) {
        if (!validBsb(v("bk-bsb"))) return fieldError(view, "bk-bsb", "A BSB is 6 digits, like 062-000.");
        const fromOnboarding = Boolean(suggested?.bank?.fromOnboarding) && !v("bk-acct");
        if (!fromOnboarding && !validAccountNumber(v("bk-acct"))) return fieldError(view, "bk-acct", "An account number is 5 to 10 digits.");
        await call("payroll_bank_request", { id, accountName: v("bk-name"), bsb: v("bk-bsb"), accountNumber: v("bk-acct"), fromOnboarding });
        suggested = null;
        await load();
        flash(view, "Sent for approval. Pay goes to the new account once someone else approves it.", "good");
        ctx.refreshCounts?.();
      } else if (e.target.matches("[data-adjust]")) {
        await call("leave_adjust", { employeeId: id, typeId: v("la-type"), kind: v("la-kind"), hours: v("la-hours"), date: v("la-date"), note: v("la-note") });
        await load();
        flash(view, "Leave balance updated.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
