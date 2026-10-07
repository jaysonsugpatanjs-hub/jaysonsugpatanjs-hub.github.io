// BAS and TPAR. A BAS is prepared, reviewed by someone else, marked lodged
// once it has been lodged with the ATO (outside this system), then paid.
// Routes: #/bas (list and new), #/bas/<id> (workpaper), #/tpar.
import { call, chip, date, dateTime, downloadCsv, field, flash, friendlyError, money, options, safe, today } from "../lib/ui.js";
import { downloadPdf } from "../lib/docs.js";

export const BAS_STATUS = { draft: ["Being prepared", "pending"], reviewed: ["Reviewed, ready to lodge", "info"], lodged: ["Lodged, not yet paid", "warn"], settled: ["Lodged and settled", "good"] };
const whole = n => `${Number(n) < 0 ? "-" : ""}$${Math.abs(Math.trunc(Number(n || 0))).toLocaleString("en-AU")}`;
const period = (a, b) => `${date(a)} to ${date(b)}`;
const FREQ = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" };

export async function renderBas(view, ctx) {
  const [id] = (ctx.sub || "").split("/");
  if (id) return workpaper(view, ctx, id);
  return list(view, ctx);
}

/* ---------------- List ---------------- */

async function list(view, ctx) {
  const d = await call("bas_list");
  const s = d.settings;
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">TAX</p><h1>BAS</h1>
      <p class="muted">Workpapers for each activity statement, worked out from the ledger. Someone other than the preparer reviews each one; it is then lodged with the ATO
        (through ATO online services or your tax agent) and marked lodged here. Nothing is sent to the ATO from this system.</p></div></header>
    <section class="panel"><h2>Settings</h2>
      <p>${s.gstRegistered ? `Registered for GST, <strong>${safe(s.basis)}</strong> basis` : "<strong>Not registered for GST</strong>: only PAYG withholding is reported"}, BAS lodged <strong>${safe(s.frequency)}</strong>.
        <span class="muted small">Change these in <a href="#/company">Company settings</a>. A BAS keeps the basis it was made with.</span></p></section>
    ${d.can.prepare ? `<form class="panel" data-new><h2>Prepare a BAS</h2>
      <div class="grid3">
        <div class="fld"><label for="bn-f">Lodged</label><select id="bn-f">${options(Object.entries(FREQ), d.next.frequency)}</select></div>
        ${field({ id: "bn-from", label: "Period from", type: "date", value: d.next.start })}
        ${field({ id: "bn-to", label: "Period to", type: "date", value: d.next.end })}
        <div class="fld"><label for="bn-m">GST reporting</label><select id="bn-m">${options([["simpler", "Simpler BAS: G1, 1A and 1B"], ["full", "Full: G1 to G20 (calculation worksheet)"]], "simpler")}</select>
          <small>Simpler BAS is for turnover under $10 million. Check which one your ATO account uses.</small></div>
      </div>
      <div class="actions"><button class="btn primary" type="submit">Prepare</button></div></form>` : ""}
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Period</th><th scope="col">Status</th><th scope="col">Due</th>
      <th scope="col" class="num">Payable (refund)</th><th scope="col">Prepared</th><th scope="col">Reviewed</th><th scope="col">Lodged</th></tr></thead><tbody>
      ${d.returns.map(r => `<tr><td><a href="#/bas/${safe(r.id)}"><strong>${period(r.from, r.to)}</strong></a><small>${safe(FREQ[r.frequency])} · ${safe(r.basis)} basis</small></td>
        <td>${chip(...BAS_STATUS[r.status])}${r.overdue ? ` ${chip("Overdue", "bad")}` : ""}</td><td class="nowrap">${date(r.due)}</td>
        <td class="num mono">${r.payable == null ? '<span class="muted">—</span>' : r.payable < 0 ? `(${whole(-r.payable)})` : whole(r.payable)}</td>
        <td>${safe(r.preparedBy || "")}</td><td>${safe(r.reviewedBy || "")}</td><td>${r.lodgedOn ? `${date(r.lodgedOn)}${r.reference ? `<small>${safe(r.reference)}</small>` : ""}` : ""}</td></tr>`).join("")
        || '<tr><td colspan="7" class="muted">No BAS prepared yet.</td></tr>'}
    </tbody></table></div>
    <p class="muted small">Due dates are for lodging yourself. Tax agents may have later dates under the lodgment program; a due date on a weekend or public holiday moves to the next business day.</p></section>
    <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  view.addEventListener("change", e => {
    if (e.target.id !== "bn-f") return;
    // Suggest the matching period length from the chosen start.
    const from = view.querySelector("#bn-from").value;
    if (!from) return;
    const months = { monthly: 1, quarterly: 3, annual: 12 }[e.target.value];
    const [y, m] = from.split("-").map(Number);
    view.querySelector("#bn-to").value = new Date(Date.UTC(y, m - 1 + months, 0)).toISOString().slice(0, 10);
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-new]")) return;
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value;
    try {
      const r = await call("bas_create", { frequency: v("bn-f"), from: v("bn-from"), to: v("bn-to"), method: v("bn-m") });
      location.hash = `#/bas/${r.id}`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Workpaper ---------------- */

const SALES_LABELS = [["G1", "Total sales (including any GST)"], ["G2", "Export sales"], ["G3", "Other GST-free sales"], ["G4", "Input taxed sales"]];
const PURCHASE_LABELS = [["G10", "Capital purchases (including any GST)"], ["G11", "Non-capital purchases (including any GST)"], ["G13", "Purchases for making input taxed sales"],
  ["G14", "Purchases without GST in the price"], ["G15", "Estimated purchases for private use or not income tax deductible"]];

function labelRows(rows, L, exact) {
  return rows.map(([k, n]) => `<tr><th scope="row"><span class="mono label-key">${k}</span> ${safe(n)}</th><td class="num mono">${whole(L[k])}${
    exact && exact[k] != null && Math.abs(exact[k] - Math.trunc(exact[k])) > 0 ? `<small class="muted">${money(exact[k])}</small>` : ""}</td></tr>`).join("");
}

async function workpaper(view, ctx, id) {
  const st = { tab: "summary", open: null, drill: {} };
  let d;
  const load = async () => { d = await call("bas_get", { id }); draw(); };
  const draw = () => {
    const b = d.bas, f = d.figures, L = f.labels, X = f.exact, c = d.can, rec = f.reconciliation || {};
    const tabs = [["summary", "BAS"], ["gst", "GST by tax code"], ["payg", "PAYG withholding"], ["rec", "Reconciliation"], ["exceptions", `To check (${d.exceptionsNow.length})`]];
    const body = {
      summary: `
        <div class="grid2">
          <section><h2>Goods and services tax</h2><table class="tbl bas-form"><tbody>
            ${labelRows(b.method === "full" ? SALES_LABELS.concat(PURCHASE_LABELS) : [SALES_LABELS[0]], L, X)}
            ${labelRows([["1A", "GST on sales"], ["1B", "GST on purchases"]], L, X)}
          </tbody></table></section>
          <section><h2>PAYG tax withheld</h2><table class="tbl bas-form"><tbody>
            ${labelRows([["W1", "Total salary, wages and other payments"], ["W2", "Amount withheld from payments shown at W1"], ["W4", "Amount withheld where no ABN is quoted"],
              ["W3", "Other amounts withheld"], ["W5", "Total amounts withheld (W2 + W4 + W3)"]], L, X)}
          </tbody></table>
          <h2>Summary</h2><table class="tbl bas-form"><tbody>
            ${labelRows([["1A", "GST on sales"], ["4", "PAYG tax withheld"], ["5A", "PAYG income tax instalment"]], L)}
            <tr class="total"><th scope="row"><span class="mono label-key">8A</span> Amount you owe the ATO</th><td class="num mono">${whole(L["8A"])}</td></tr>
            ${labelRows([["1B", "GST on purchases"], ["7D", "Fuel tax credit"]], L)}
            <tr class="total"><th scope="row"><span class="mono label-key">8B</span> Amount the ATO owes you</th><td class="num mono">${whole(L["8B"])}</td></tr>
            <tr class="total"><th scope="row"><span class="mono label-key">9</span> ${L["9"] >= 0 ? "Payment due" : "Refund due"}</th><td class="num mono"><strong>${whole(Math.abs(L["9"]))}</strong></td></tr>
          </tbody></table></section>
        </div>
        <p class="muted small">Whole dollars, as entered on the activity statement: cents are dropped from each label. The exact amount is shown beside a label where it had cents.
          ${b.method === "simpler" ? "Simpler BAS: only G1, 1A and 1B are reported for GST; the other G labels are in the GST tab for checking." : ""}</p>`,
      gst: `
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Tax code</th><th scope="col">Labels</th><th scope="col" class="num">Amount</th><th scope="col" class="num">GST</th><th scope="col" class="num">Including GST</th><th scope="col"></th></tr></thead><tbody>
          ${f.codes.map(cd => `<tr><td><strong>${safe(cd.code)}</strong> ${safe(cd.name)}</td><td class="mono">${safe(cd.labels.join(", "))}</td><td class="num mono">${money(cd.base)}</td>
            <td class="num mono">${money(cd.gst)}</td><td class="num mono">${money(cd.gross)}</td><td><button type="button" class="link" data-drill="${safe(cd.id)}">${st.open === cd.id ? "Hide" : "Entries"}</button></td></tr>
            ${st.open === cd.id ? `<tr class="sub-row"><td colspan="6">${drillTable(st.drill[cd.id])}</td></tr>` : ""}`).join("")
            || '<tr><td colspan="6" class="muted">No GST-coded amounts in the period.</td></tr>'}
        </tbody></table></div>
        ${`<h2>Calculation worksheet</h2><table class="tbl bas-form"><tbody>
          ${[["G5", "G2 + G3 + G4"], ["G6", "G1 less G5"], ["G8", "G6 + G7 (adjustments)"], ["G9", "GST on sales: G8 divided by 11"], ["G12", "G10 + G11"], ["G16", "G13 + G14 + G15"],
             ["G17", "G12 less G16"], ["G19", "G17 + G18 (adjustments)"], ["G20", "GST on purchases: G19 divided by 11"]]
            .map(([k, n]) => `<tr><th scope="row"><span class="mono label-key">${k}</span> ${safe(n)}</th><td class="num mono">${money(X[k])}</td><td></td></tr>`).join("")}
          <tr><th scope="row">1A from the GST charged / G9</th><td class="num mono">${money(X["1A"])} / ${money(X.G9)}</td><td class="${Math.abs(X["1A"] - X.G9) > 1 ? "bad-text" : "muted"} small">${Math.abs(X["1A"] - X.G9) > 1 ? "Check: a GST-free or input-taxed item may be coded with GST" : "Agree"}</td></tr>
          <tr><th scope="row">1B from the GST paid / G20</th><td class="num mono">${money(X["1B"])} / ${money(X.G20)}</td><td class="${Math.abs(X["1B"] - X.G20) > 1 ? "bad-text" : "muted"} small">${Math.abs(X["1B"] - X.G20) > 1 ? "Check the purchase coding" : "Agree"}</td></tr>
        </tbody></table>`}`,
      payg: `
        <table class="tbl bas-form"><tbody>
          <tr><th scope="row"><span class="mono label-key">W1</span> Pay subject to withholding, from pay runs paid in the period (after salary sacrifice)</th><td class="num mono">${money(X.W1)}</td><td></td></tr>
          <tr><th scope="row"><span class="mono label-key">W2</span> PAYG withheld by those pay runs</th><td class="num mono">${money(X.W2)}</td><td></td></tr>
          <tr><th scope="row"><span class="mono label-key">W4</span> Withheld from suppliers who quoted no ABN (bills dated in the period)</th><td class="num mono">${money(X.W4)}</td><td></td></tr>
          <tr><th scope="row"><span class="mono label-key">W3</span> Other amounts withheld</th><td class="num mono">${money(X.W3)}</td><td class="muted small">Not used by Panalo; enter on the BAS by hand if ever needed</td></tr>
          <tr class="total"><th scope="row"><span class="mono label-key">W5</span> Total withheld</th><td class="num mono">${money(X.W5)}</td><td></td></tr>
        </tbody></table>
        <p class="muted small">If the ATO has pre-filled W1 and W2 from Single Touch Payroll, compare them with these before lodging. Single Touch Payroll reporting from this system comes in Phase 8.</p>`,
      rec: `
        ${rec.gst ? `<h2>GST account</h2><table class="tbl bas-form"><tbody>
          <tr><th scope="row">Movement on the GST account in the period (BAS transfers left out)</th><td class="num mono">${money(rec.gst.accountMovement)}</td><td></td></tr>
          <tr><th scope="row">${rec.gst.accrualExpected != null ? "GST on sales less GST on purchases, accrual basis" : "1A less 1B"}</th><td class="num mono">${money(rec.gst.accrualExpected ?? rec.gst.expected)}</td><td></td></tr>
          <tr class="total"><th scope="row">Difference</th><td class="num mono ${Math.abs(rec.gst.difference) >= 0.01 ? "bad-text" : ""}">${money(rec.gst.difference)}</td>
            <td class="small muted">${Math.abs(rec.gst.difference) < 0.01 ? "Agrees" : Math.abs(rec.gst.notFromTaxLines) >= 0.01 ? `${money(rec.gst.notFromTaxLines)} was posted straight to the GST account (see To check)` : "Check entries to the GST account"}</td></tr>
          ${rec.gst.accrualExpected != null ? `<tr><th scope="row">This BAS (cash basis): 1A less 1B</th><td class="num mono">${money(rec.gst.expected)}</td><td class="small muted">The rest stays in the GST account until invoices and bills are paid</td></tr>` : ""}
        </tbody></table>` : ""}
        ${rec.payg ? `<h2>PAYG withholding account</h2><table class="tbl bas-form"><tbody>
          <tr><th scope="row">Posted by pay runs paid in the period</th><td class="num mono">${money(rec.payg.payRuns)}</td><td class="small ${Math.abs(rec.payg.payRunDifference) >= 0.01 ? "bad-text" : "muted"}">W2 ${money(rec.payg.w2)}${Math.abs(rec.payg.payRunDifference) >= 0.01 ? `: differs by ${money(rec.payg.payRunDifference)}` : ": agrees"}</td></tr>
          <tr><th scope="row">No-ABN withholding posted on bills</th><td class="num mono">${money(rec.payg.bills)}</td><td class="small muted">W4 ${money(rec.payg.w4)}</td></tr>
          <tr><th scope="row">Other entries to the account</th><td class="num mono">${money(rec.payg.other)}</td><td class="small muted">${Math.abs(rec.payg.other) >= 0.01 ? "Not on this BAS: check them" : ""}</td></tr>
        </tbody></table>` : ""}`,
      exceptions: `
        ${d.exceptionsNow.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col"></th><th scope="col">Entry</th><th scope="col">What to check</th><th scope="col" class="num">Amount</th></tr></thead><tbody>
          ${d.exceptionsNow.map(e => `<tr><td>${chip(e.severity === "warn" ? "Check" : "Note", e.severity === "warn" ? "warn" : "")}</td>
            <td class="nowrap">${e.journalId ? `<a href="#/journals/${safe(e.journalId)}">${safe(e.number || "")}</a>` : safe(e.number || "")}<small>${e.date ? date(e.date) : ""}</small></td>
            <td>${safe(e.message)}</td><td class="num mono">${e.amount == null ? "" : money(e.amount)}</td></tr>`).join("")}
        </tbody></table></div>` : '<p class="muted">Nothing to check: every amount is coded and the accounts agree.</p>'}`
    };
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">TAX · BAS</p><h1>${period(b.from, b.to)} ${chip(...BAS_STATUS[b.status])}</h1>
        <p class="muted">${safe(FREQ[b.frequency])} · GST ${safe(b.basis)} basis · ${b.method === "full" ? "full reporting" : "simpler BAS"} · due ${date(b.due)}</p></div>
        <div class="top-actions"><button type="button" class="btn" data-pdf>Workpaper (PDF)</button> <a class="btn" href="#/bas">All BAS</a></div></header>
      ${d.changes.length ? `<div class="note">${b.status === "reviewed"
        ? `<strong>The books changed after this BAS was reviewed${b.fixedAt ? ` (${dateTime(b.fixedAt)})` : ""}.</strong> Send it back to draft and review it again before lodging.`
        : "<strong>Entries in this period changed after it was lodged.</strong> They will be carried into the next BAS you prepare as adjustments (or you can revise this BAS with the ATO):"}
        <ul>${d.changes.map(x => `<li><span class="mono">${safe(x.label)}</span> ${x.change > 0 ? "+" : ""}${money(x.change)}</li>`).join("")}</ul></div>` : ""}
      ${f.adjustments.length ? `<div class="note"><strong>Includes changes to earlier BAS after they were lodged:</strong>
        <ul>${f.adjustments.map(a => `<li><a href="#/bas/${safe(a.basId)}">${safe(a.period)}</a>: ${a.labels.map(l => `<span class="mono">${safe(l.label)}</span> ${l.amount > 0 ? "+" : ""}${money(l.amount)}`).join(", ")}</li>`).join("")}</ul></div>` : ""}
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === st.tab}" class="${k === st.tab ? "on" : ""}" data-tab="${k}">${safe(l)}</button>`).join("")}</div>
      <section class="panel">${body[st.tab]}</section>
      ${steps(d)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const drillTable = r => {
    if (!r) return '<p class="muted small">Loading…</p>';
    return `${r.cashNote ? `<p class="muted small">${safe(r.cashNote)}</p>` : ""}${r.truncated ? '<p class="small bad-text">Only the first 5,000 lines are listed.</p>' : ""}<table class="tbl compact"><tbody>${r.rows.map(x => `<tr><td class="nowrap">${date(x.date)}</td>
      <td><a href="#/journals/${safe(x.journalId)}">${safe(x.number)}</a> <small>${safe(x.memo)}</small><small>${safe(x.accounts)}</small></td><td class="num mono">${money(x.base)}</td><td class="num mono">${money(x.gst)}</td></tr>`).join("")
      || '<tr><td class="muted">No entries.</td></tr>'}</tbody></table>`;
  };
  await load();

  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-tab]"), drill = e.target.closest("[data-drill]"), act = e.target.closest("[data-act]");
    try {
      if (tab) { st.tab = tab.dataset.tab; draw(); }
      else if (drill) {
        const codeId = drill.dataset.drill;
        st.open = st.open === codeId ? null : codeId;
        draw();
        if (st.open && !st.drill[codeId]) { st.drill[codeId] = await call("bas_lines", { id, taxCodeId: codeId }); draw(); }
      } else if (e.target.closest("[data-pdf]")) await downloadPdf("bas_pdf", { id });
      else if (act?.dataset.act === "reopen") {
        const reason = window.prompt("Send this BAS back to draft? Its figures will be worked out again and it will need another review. Say why:", "");
        if (reason === null) return;
        await call("bas_reopen", { id, reason }); await load(); flash(view, "Back to draft.", "good");
      } else if (e.target.closest("[data-void]")) {
        const reason = window.prompt("Void this payment? Its journal is reversed and the amount is owing again. Say why:", "");
        if (reason === null) return;
        await call("bas_payment_void", { id, paymentId: e.target.closest("[data-void]").dataset.void, reason }); await load(); flash(view, "Payment voided.", "good");
      } else if (act?.dataset.act === "delete") {
        if (!window.confirm("Delete this draft BAS? Nothing has been lodged or posted.")) return;
        await call("bas_delete", { id }); location.hash = "#/bas";
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, v = x => f.querySelector(`[name=${x}]`)?.value ?? "";
    const btn = f.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    try {
      if (f.matches("[data-save]")) {
        await call("bas_save", { id, instalment5A: v("i5a"), fuelCredit7D: v("f7d"), method: v("method"), notes: v("notes") });
        await load(); flash(view, "Saved.", "good");
      } else if (f.matches("[data-review]")) {
        if (!window.confirm("Mark this BAS as reviewed? Its figures are fixed now, and it can then be lodged.")) { btn.disabled = false; return; }
        await call("bas_review", { id, comment: v("comment") });
        await load(); flash(view, "Reviewed. The preparer has been told it's ready to lodge.", "good"); ctx.refreshCounts?.();
      } else if (f.matches("[data-lodge]")) {
        if (!window.confirm("Has this BAS been lodged with the ATO with exactly these amounts? This posts the transfer to the ATO account and can't be undone.")) { btn.disabled = false; return; }
        await call("bas_lodge", { id, lodgedOn: v("lodged"), reference: v("ref"), lock: f.querySelector("[name=lock]").checked });
        await load(); flash(view, "Marked lodged and posted to the ATO account.", "good"); ctx.refreshCounts?.();
      } else if (f.matches("[data-pay]")) {
        await call("bas_record_payment", { id, bankAccountId: v("bank"), date: v("date"), amount: v("amount") });
        await load(); flash(view, d.bas.payable > 0 ? "Payment recorded." : "Refund recorded.", "good");
      }
    } catch (error) { if (btn) btn.disabled = false; flash(view, friendlyError(error), "bad"); }
  });
}

function steps(d) {
  const b = d.bas, c = d.can;
  const left = Math.abs(b.payable || 0) - b.settled;
  return `<section class="panel"><h2>Prepare, review, lodge, pay</h2>
    <ol class="steps">
      <li>Prepared by ${safe(b.preparedBy || "")} ${dateTime(b.preparedAt)}</li>
      <li>${b.reviewedBy ? `Reviewed by ${safe(b.reviewedBy)}${b.reviewComment ? `: “${safe(b.reviewComment)}”` : ""}` : "Review by someone other than the preparer (Review BAS permission)"}</li>
      <li>${b.lodgedOn ? `Lodged ${date(b.lodgedOn)}${b.reference ? `, reference ${safe(b.reference)}` : ""}${b.lodgedBy ? ` (marked by ${safe(b.lodgedBy)})` : ""}${b.journal ? ` · <a href="#/journals/${safe(b.journal.id)}">${safe(b.journal.number)}</a>` : ""}${b.lockedPeriods ? ` · ${b.lockedPeriods} month(s) locked` : ""}`
        : "Lodge with the ATO (online services or your tax agent), then mark it lodged here"}</li>
      <li>${b.status === "settled" ? (b.payable ? "Settled" : "Nothing to pay") : b.payable == null ? "Pay the ATO, or receive the refund" : `${b.payable > 0 ? "To pay" : "Refund to receive"}: ${money(left)} of ${money(Math.abs(b.payable))}`}</li>
    </ol>
    ${c.edit ? `<form data-save><div class="grid3">
      ${field({ id: "b-5a", label: "5A PAYG income tax instalment ($)", value: b.instalment5A || "", attrs: 'name="i5a" inputmode="numeric"', hint: "From your instalment notice, or T7 to T11 on the BAS" })}
      ${field({ id: "b-7d", label: "7D Fuel tax credit ($)", value: b.fuelCredit7D || "", attrs: 'name="f7d" inputmode="numeric"', hint: "From your fuel tax credit calculator" })}
      <div class="fld"><label for="b-m">GST reporting</label><select id="b-m" name="method">${options([["simpler", "Simpler BAS"], ["full", "Full (G1 to G20)"]], b.method)}</select></div>
      </div>
      <div class="fld"><label for="b-n">Notes for the reviewer</label><textarea id="b-n" name="notes" rows="2" maxlength="2000">${safe(b.notes || "")}</textarea></div>
      <div class="actions"><button class="btn" type="submit">Save</button> ${c.delete ? '<button type="button" class="btn danger" data-act="delete">Delete draft</button>' : ""}</div></form>`
      : b.notes ? `<p class="muted small">Notes: ${safe(b.notes)}</p>` : ""}
    ${b.status === "draft" && !c.review ? '<p class="muted small">Waiting for review by someone with the Review BAS permission who didn’t prepare or change it.</p>' : ""}
    ${c.review ? `<form data-review class="toolbar"><div class="fld wide"><label for="b-rc">Review comment (optional)</label><input id="b-rc" name="comment" maxlength="1000"></div>
      <button class="btn primary" type="submit">Mark reviewed</button></form>` : ""}
    ${c.lodge ? `<form data-lodge><div class="grid3">
      ${field({ id: "b-ld", label: "Date lodged with the ATO", type: "date", value: today(), attrs: 'name="lodged"' })}
      ${field({ id: "b-ref", label: "ATO receipt or reference (optional)", attrs: 'name="ref" maxlength="60"' })}
      </div>
      <label class="check"><input type="checkbox" name="lock" checked> Lock the months of this BAS (only people who can reopen periods can post into them)</label>
      <div class="actions"><button class="btn primary" type="submit">Mark lodged</button> ${c.reopen ? '<button type="button" class="btn" data-act="reopen">Back to draft</button>' : ""}</div></form>` : ""}
    ${c.pay ? `<form data-pay class="toolbar">
      <div class="fld"><label for="b-bk">${b.payable > 0 ? "Paid from" : "Received into"}</label><select id="b-bk" name="bank">${options(d.bankAccounts.map(a => [a.id, `${a.code} ${a.name}`]))}</select></div>
      ${field({ id: "b-pd", label: "Date", type: "date", value: today(), attrs: 'name="date"' })}
      ${field({ id: "b-pa", label: "Amount", value: left.toFixed(2), attrs: 'name="amount" inputmode="decimal"' })}
      <button class="btn primary" type="submit">${b.payable > 0 ? "Record payment" : "Record refund"}</button></form>
      <p class="muted small">Record it here, then match the bank statement line to this payment in Reconciliation.</p>` : ""}
    ${d.payments.length ? `<table class="tbl compact"><tbody>${d.payments.map(p => `<tr><td>${date(p.date)}</td><td>${p.amount > 0 ? "Paid to the ATO" : "Refund from the ATO"} · ${safe(p.bank)}
      ${p.voided ? `<small class="bad-text">Voided: ${safe(p.voidReason || "")}</small>` : ""}</td>
      <td><a href="#/journals/${safe(p.journalId)}">${safe(p.journal || "")}</a></td><td class="num mono">${money(Math.abs(p.amount))}</td>
      <td>${c.voidPayment && !p.voided ? `<button type="button" class="link" data-void="${safe(p.id)}">Void</button>` : ""}</td></tr>`).join("")}</tbody></table>` : ""}
  </section>`;
}

/* ---------------- TPAR ---------------- */

export async function renderTpar(view, ctx) {
  let yearStart = null;
  const load = async () => {
    const d = await call("tpar_get", yearStart ? { yearStart } : {});
    yearStart = d.year.start;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">TAX</p><h1>Taxable payments annual report</h1>
        <p class="muted">Payments made in the financial year to contractors marked "Report on the TPAR" (building and construction services). Report them to the ATO by 28 August
          through ATO online services or your tax agent; this system doesn't lodge it.</p></div>
        <div class="top-actions"><div class="fld"><label for="tp-y">Financial year</label><select id="tp-y">${options(d.years.map(y => [y.start, y.label]), d.year.start)}</select></div></div></header>
      <div class="cards figures">
        <section class="card"><h2>Contractors</h2><p class="big mono">${d.totals.count}</p></section>
        <section class="card"><h2>Gross paid</h2><p class="big mono">${money(d.totals.gross)}</p><p class="muted small">Including GST and any tax withheld</p></section>
        <section class="card"><h2>GST</h2><p class="big mono">${money(d.totals.gst)}</p></section>
        <section class="card"><h2>Due</h2><p class="big">${date(d.year.due)}</p><p class="muted small">${d.lodged ? `Lodged ${date(d.lodged.on)}` : d.year.ended ? "Not marked lodged" : "Year not over yet"}</p></section>
      </div>
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Contractor</th><th scope="col">ABN</th><th scope="col">Address</th>
        <th scope="col" class="num">Gross paid</th><th scope="col" class="num">GST</th><th scope="col" class="num">Tax withheld (no ABN)</th></tr></thead><tbody>
        ${d.rows.map(r => `<tr><td><a href="#/suppliers/${safe(r.supplierId)}">${safe(r.name)}</a>${r.tradingName ? `<small>${safe(r.tradingName)}</small>` : ""}
          ${r.problems.map(p => `<small class="bad-text">${safe(p)}</small>`).join("")}</td>
          <td class="mono nowrap">${safe(r.abn ? r.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4") : "None")}</td><td>${safe(r.address)}</td>
          <td class="num mono">${money(r.gross)}</td><td class="num mono">${money(r.gst)}</td><td class="num mono">${money(r.withheld)}</td></tr>`).join("")
          || '<tr><td colspan="6" class="muted">No payments to reportable contractors in this year.</td></tr>'}
      </tbody></table></div>
      <div class="actions"><button type="button" class="btn" data-csv ${d.rows.length ? "" : "disabled"}>Download (CSV)</button></div>
      <p class="muted small">Amounts are the share of each bill paid in the year, so part-paid bills count in part. Payments for materials only shouldn't be reported: untick
        "Report on the TPAR" on suppliers who only sell materials.</p></section>
      ${d.notMarked.length ? `<section class="panel"><h2>Subcontractors paid but not marked for the TPAR</h2>
        <p class="muted small">Check whether these provided building and construction services. If they did, tick "Report on the TPAR" on the supplier.</p>
        <table class="tbl compact"><tbody>${d.notMarked.map(n => `<tr><td><a href="#/suppliers/${safe(n.supplierId)}">${safe(n.name)}</a></td><td class="num mono">${money(n.paid)}</td></tr>`).join("")}</tbody></table></section>` : ""}
      ${d.lodged ? `<section class="panel"><p>Marked lodged ${date(d.lodged.on)}${d.lodged.reference ? `, reference ${safe(d.lodged.reference)}` : ""}${d.lodged.by ? ` by ${safe(d.lodged.by)}` : ""}:
        ${d.lodged.totals.count} contractor(s), ${money(d.lodged.totals.gross)}.</p></section>`
        : d.can.lodge ? `<form class="panel toolbar" data-lodge>
        ${field({ id: "tp-on", label: "Date lodged with the ATO", type: "date", value: today() })}${field({ id: "tp-ref", label: "Reference (optional)", attrs: 'maxlength="60"' })}
        <button class="btn primary" type="submit">Mark lodged</button></form>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    return d;
  };
  let d = await load();
  view.addEventListener("change", async e => {
    if (e.target.id !== "tp-y") return;
    yearStart = e.target.value;
    try { d = await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", e => {
    if (!e.target.closest("[data-csv]")) return;
    downloadCsv(`TPAR-${d.year.start.slice(0, 4)}-${d.year.end.slice(2, 4)}.csv`, [["ABN", "Name", "Trading name", "Address", "Gross amount paid (incl GST)", "Total GST", "Total tax withheld (no ABN)"],
      ...d.rows.map(r => [r.abn || "", r.name, r.tradingName || "", r.address, r.gross.toFixed(2), r.gst.toFixed(2), r.withheld.toFixed(2)])]);
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-lodge]")) return;
    e.preventDefault();
    try {
      await call("tpar_lodge", { yearStart, lodgedOn: view.querySelector("#tp-on").value, reference: view.querySelector("#tp-ref").value });
      d = await load(); flash(view, "Marked lodged.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
