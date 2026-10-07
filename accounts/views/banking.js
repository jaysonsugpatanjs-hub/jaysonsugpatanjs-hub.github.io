// Banking: bank accounts and statement imports, matching and reconciliation,
// bank rules. Routes:
//   #/bank-accounts                        accounts, ABA settings
//   #/bank-accounts/<ledgerId>/import      import a statement file
//   #/reconciliation/<ledgerId>?tab=...    match, matched, excluded, reconcile, history
//   #/reconciliation/report/<recId>        a completed reconciliation
//   #/bank-rules                           rules
import { call, chip, date, dateTime, field, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";
import { accountOptions } from "../lib/docs.js";
import { detectFormat, guessCsvMapping, parseCsv, parseOfx, parseQif, rowsFromCsv } from "../lib/bank-file.js";

const SOURCE = { customer_payment: "Receipt", supplier_payment: "Supplier payment", pay_run_payment: "Net pay", pay_run_super: "Super", bank_transaction: "From the bank line",
  manual: "Journal", pay_run: "Pay run" };
const signed = n => `<span class="${n < 0 ? "bad-text" : ""}">${money(n)}</span>`;

/* ---------------- Bank accounts ---------------- */

export async function renderBankAccounts(view, ctx) {
  const [id, sub] = (ctx.sub || "").split("/");
  if (id && sub === "import") return importScreen(view, ctx, id);
  const d = await call("banking_overview");
  const ledgerList = d.accounts.map(a => [a.id, `${a.code} ${a.name}`]);
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Bank accounts</h1>
      <p class="muted">Import statements, match each line to what it pays, and reconcile to the statement balance.</p></div>
      ${d.can.manage ? '<a class="btn" href="#/bank-rules">Bank rules</a>' : ""}</header>
    <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Account</th><th scope="col" class="num">Ledger balance</th>
      <th scope="col" class="num">Statement balance</th><th scope="col" class="num">Lines to match</th><th scope="col">Reconciled to</th><th scope="col"></th></tr></thead><tbody>
      ${d.accounts.map(a => `<tr><td><a href="#/reconciliation/${safe(a.id)}"><strong>${safe(a.code)} ${safe(a.name)}</strong></a>${a.linked ? `<small>${safe(a.linked.nickname)}</small>` : ""}</td>
        <td class="num mono">${money(a.ledgerBalance)}</td>
        <td class="num mono">${a.statementBalance == null ? "—" : `${money(a.statementBalance)}<small>${date(a.statementDate)}</small>`}</td>
        <td class="num">${a.toMatch ? chip(String(a.toMatch), "pending") : "0"}</td>
        <td>${a.lastReconciled ? `${date(a.lastReconciled)}<small>${money(a.reconciledBalance)}</small>` : '<span class="muted">Not yet</span>'}</td>
        <td class="row-acts">${d.can.manage ? `<a class="btn" href="#/bank-accounts/${safe(a.id)}/import">Import statement</a> ` : ""}<a class="btn" href="#/reconciliation/${safe(a.id)}">Reconcile</a></td></tr>`).join("")
        || '<tr><td colspan="6" class="muted">No bank accounts in the chart of accounts.</td></tr>'}
    </tbody></table></div>
    <p class="muted small">Ledger balance is as at today. Statement balance is from the latest imported file that gave one.</p></section>
    <section class="panel"><h2>Company bank accounts and bank files</h2>
      <p class="muted">Link each real account to its ledger account, and add the details your bank gave you for direct entry (ABA) files.
        New accounts and changes to BSB or account number are made in <a href="#/company">Company settings</a> and need a second person's approval.</p>
      ${d.companyAccounts.map(c => `<form class="panel" data-bank-settings="${safe(c.id)}">
        <div class="head-row"><h3>${safe(c.nickname)} ${c.status === "pending" ? chip("Waiting for approval", "pending") : c.abaReady ? chip("Ready for bank files", "good") : chip("Bank files not set up", "")}</h3>
          <span class="mono">BSB ${safe(c.bsb)} · ${safe(c.accountNumber)}</span></div>
        <div class="grid3">
          <div class="fld"><label for="bs-l-${safe(c.id)}">Ledger account</label><select id="bs-l-${safe(c.id)}" name="ledgerAccountId" ${d.can.manage ? "" : "disabled"}>
            <option value="">Not linked</option>${options(ledgerList, c.ledgerAccountId)}</select></div>
          ${field({ id: `bs-a-${c.id}`, label: "APCA user ID", value: c.apcaUserId || "", attrs: `name="apcaUserId" inputmode="numeric" maxlength="6" ${d.can.manage ? "" : "disabled"}`, hint: "6 digits, from your bank" })}
          ${field({ id: `bs-c-${c.id}`, label: "Bank code", value: c.abaBankCode || "", attrs: `name="abaBankCode" maxlength="3" ${d.can.manage ? "" : "disabled"}`, hint: "e.g. CBA, WBC, NAB, ANZ" })}
          ${field({ id: `bs-u-${c.id}`, label: "User name for bank files", value: c.abaUserName || "", attrs: `name="abaUserName" maxlength="26" ${d.can.manage ? "" : "disabled"}`, hint: "As registered with the bank" })}
        </div>
        <label class="check"><input type="checkbox" name="abaBalancing" ${c.abaBalancing ? "checked" : ""} ${d.can.manage ? "" : "disabled"}> Add a balancing debit line (some banks require it; ask yours)</label>
        ${d.can.manage ? '<div class="actions"><button class="btn" type="submit">Save</button></div>' : ""}
      </form>`).join("") || '<p class="muted">No company bank accounts yet. Add them in Company settings.</p>'}
    </section>
    <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  view.addEventListener("submit", async e => {
    const f = e.target.closest("[data-bank-settings]");
    if (!f) return;
    e.preventDefault();
    const v = n => f.querySelector(`[name=${n}]`);
    try {
      await call("bank_settings_save", { id: f.dataset.bankSettings, ledgerAccountId: v("ledgerAccountId").value, apcaUserId: v("apcaUserId").value.trim(),
        abaBankCode: v("abaBankCode").value.trim().toUpperCase(), abaUserName: v("abaUserName").value.trim(), abaBalancing: v("abaBalancing").checked });
      flash(view, "Saved.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Import ---------------- */

async function importScreen(view, ctx, accountId) {
  const [d, hist] = await Promise.all([call("banking_overview"), call("bank_imports_list", { accountId })]);
  const acc = d.accounts.find(a => a.id === accountId);
  if (!acc) { view.innerHTML = '<section class="panel"><p class="muted">Bank account not found.</p></section>'; return; }
  const st = { file: null, text: "", format: "csv", cells: [], mapping: null, order: "dmy", flip: false, parsed: { rows: [], errors: [] }, balance: "", balanceDate: "" };
  const cols = () => Math.max(0, ...st.cells.map(r => r.length));
  const colOptions = (sel, allowNone = true) => `${allowNone ? '<option value="-1">None</option>' : ""}${Array.from({ length: cols() }, (_, i) =>
    `<option value="${i}" ${i === sel ? "selected" : ""}>${safe(st.mapping?.header ? st.cells[0][i] || `Column ${i + 1}` : `Column ${i + 1}: ${(st.cells[0]?.[i] || "").slice(0, 24)}`)}</option>`).join("")}`;
  const reparse = () => {
    if (st.format === "csv") st.parsed = rowsFromCsv(st.cells, st.mapping, { order: st.order, flip: st.flip });
    else if (st.format === "ofx") { const r = parseOfx(st.text); st.parsed = r; if (!st.balance && r.balance) { st.balance = r.balance; st.balanceDate = r.balanceDate || ""; } }
    else st.parsed = parseQif(st.text, st.order);
    if (st.format === "csv" && !st.balance) {
      const withBal = st.parsed.rows.filter(r => r.balance != null);
      if (withBal.length) {
        const last = [...withBal].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
        st.balanceDate = last.date;
        // Files list newest first or last; the balance on the latest line is the closing balance.
        const latest = withBal.filter(r => r.date === last.date);
        st.balance = (withBal.indexOf(latest[0]) === 0 ? latest[0] : latest[latest.length - 1]).balance;
      }
    }
  };
  const draw = () => {
    const rows = st.parsed.rows;
    const total = rows.reduce((t, r) => t + Math.round(Number(r.amount) * 100), 0) / 100;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Import a statement</h1>
        <p class="muted">${safe(acc.code)} ${safe(acc.name)}. CSV, OFX/QFX or QIF from your bank's internet banking. Lines already imported are skipped.</p></div>
        <a class="btn" href="#/reconciliation/${safe(accountId)}">Back to reconciliation</a></header>
      <section class="panel">
        <div class="fld"><label for="im-file">Statement file</label><input id="im-file" type="file" accept=".csv,.ofx,.qfx,.qif,.txt,text/csv"></div>
        ${st.file ? `<p class="muted small">${safe(st.file.name)} · read as ${st.format.toUpperCase()}</p>` : ""}
        ${st.file && st.format === "csv" ? `<h2>Columns</h2>
          <div class="grid3">
            <div class="fld"><label for="im-date">Date</label><select id="im-date" data-map="date">${colOptions(st.mapping.date, false)}</select></div>
            <div class="fld"><label for="im-amt">Amount (one column, money out negative)</label><select id="im-amt" data-map="amount">${colOptions(st.mapping.amount)}</select></div>
            <div class="fld"><label for="im-desc">Description</label><select id="im-desc" data-map="description">${colOptions(st.mapping.description, false)}</select></div>
            <div class="fld"><label for="im-deb">Or: money out column</label><select id="im-deb" data-map="debit">${colOptions(st.mapping.debit)}</select></div>
            <div class="fld"><label for="im-cred">and money in column</label><select id="im-cred" data-map="credit">${colOptions(st.mapping.credit)}</select></div>
            <div class="fld"><label for="im-ref">Reference</label><select id="im-ref" data-map="reference">${colOptions(st.mapping.reference)}</select></div>
            <div class="fld"><label for="im-bal">Balance</label><select id="im-bal" data-map="balance">${colOptions(st.mapping.balance)}</select></div>

          </div>
          <label class="check"><input type="checkbox" id="im-header" ${st.mapping.header ? "checked" : ""}> The first row is headings</label>
          <label class="check"><input type="checkbox" id="im-flip" ${st.flip ? "checked" : ""}> Swap money in and out (the file shows spending as positive)</label>` : ""}
        ${st.file && st.format !== "ofx" ? `<div class="fld"><label for="im-order">Dates are written</label><select id="im-order">${options([["dmy", "Day/month/year (Australian banks)"], ["mdy", "Month/day/year (Quicken and US software)"]], st.order)}</select>
          ${st.format === "qif" ? "<small>QIF files from Quicken usually use month/day/year. Check the preview dates.</small>" : ""}</div>` : ""}
      </section>
      ${st.file ? `<section class="panel"><h2>Preview</h2>
        ${st.parsed.errors.length ? `<div class="note"><strong>${st.parsed.errors.length} line(s) can't be read and will be left out:</strong><ul>${st.parsed.errors.slice(0, 8).map(e => `<li>${safe(e)}</li>`).join("")}</ul></div>` : ""}
        <p>${rows.length} line(s), ${rows.length ? `${date(rows.map(r => r.date).sort()[0])} to ${date(rows.map(r => r.date).sort().at(-1))}, ` : ""}net ${money(total)}.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Reference</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Balance</th></tr></thead><tbody>
          ${rows.slice(0, 12).map(r => `<tr><td class="nowrap">${date(r.date)}</td><td>${safe(r.description)}</td><td>${safe(r.reference)}</td><td class="num mono">${signed(Number(r.amount))}</td>
            <td class="num mono">${r.balance == null ? "" : money(Number(r.balance))}</td></tr>`).join("")}
          ${rows.length > 12 ? `<tr><td colspan="5" class="muted">and ${rows.length - 12} more</td></tr>` : ""}
        </tbody></table></div>
        <form data-do-import><div class="grid3">
          ${field({ id: "im-sbal", label: "Closing balance on the statement (optional)", value: st.balance || "", attrs: 'inputmode="decimal"', hint: "Used to check the reconciliation" })}
          ${field({ id: "im-sdate", label: "Balance date", type: "date", value: st.balanceDate || "" })}
        </div>
        <div class="actions"><button class="btn primary" type="submit" ${rows.length ? "" : "disabled"}>Import ${rows.length} line(s)</button></div></form>
      </section>` : ""}
      <section class="panel"><h2>Earlier imports</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">File</th><th scope="col">Lines</th><th scope="col">Dates</th><th scope="col">Imported</th><th scope="col"></th></tr></thead><tbody>
          ${hist.imports.map(i => `<tr><td>${safe(i.fileName)} <small>${safe(i.format.toUpperCase())}</small></td><td>${i.added} new of ${i.rows}</td>
            <td class="nowrap">${i.from ? `${date(i.from)} to ${date(i.to)}` : "—"}</td><td>${safe(i.by)} ${dateTime(i.at)}</td>
            <td>${i.undoneAt ? chip("Undone", "") : `<button type="button" class="link" data-undo="${safe(i.id)}">Undo</button>`}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}
        </tbody></table></div></section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  draw();
  view.addEventListener("change", async e => {
    const t = e.target;
    if (t.id === "im-file") {
      const f = t.files?.[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) return flash(view, "That file is over 5 MB. Export a shorter date range.", "bad");
      st.file = f; st.text = await f.text(); st.format = detectFormat(f.name, st.text); st.balance = ""; st.balanceDate = "";
      if (st.format === "csv") { st.cells = parseCsv(st.text); st.mapping = guessCsvMapping(st.cells, st.order); }
      reparse(); draw();
    } else if (t.dataset.map) { st.mapping[t.dataset.map] = Number(t.value); if (t.dataset.map === "amount" && Number(t.value) >= 0) { st.mapping.debit = -1; st.mapping.credit = -1; }
      if (["debit", "credit"].includes(t.dataset.map) && Number(t.value) >= 0) st.mapping.amount = -1; st.balance = ""; reparse(); draw(); }
    else if (t.id === "im-order") { st.order = t.value; reparse(); draw(); }
    else if (t.id === "im-header") { st.mapping.header = t.checked; reparse(); draw(); }
    else if (t.id === "im-flip") { st.flip = t.checked; reparse(); draw(); }
  });
  view.addEventListener("click", async e => {
    const u = e.target.closest("[data-undo]");
    if (!u) return;
    if (!window.confirm("Remove every line this file added? Only possible while none of them has been matched or excluded.")) return;
    try { await call("bank_import_undo", { id: u.dataset.undo }); hist.imports = (await call("bank_imports_list", { accountId })).imports; draw(); flash(view, "Import undone.", "good"); }
    catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-do-import]")) return;
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const r = await call("bank_import", { accountId, fileName: st.file.name, format: st.format, rows: st.parsed.rows,
        statementBalance: view.querySelector("#im-sbal").value.replace(/[$,\s]/g, ""), balanceDate: view.querySelector("#im-sdate").value });
      location.hash = `#/reconciliation/${accountId}?imported=${r.added}&skipped=${r.skipped}${r.beforeReconciled ? `&early=${r.beforeReconciled}&rec=${r.reconciledTo}` : ""}`;
    } catch (error) { btn.disabled = false; flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Reconciliation ---------------- */

export async function renderReconciliation(view, ctx) {
  const [first, second] = (ctx.sub || "").split("/");
  if (first === "report" && second) return report(view, second);
  const d = await call("banking_overview");
  const accountId = first || d.accounts[0]?.id;
  if (!accountId) { view.innerHTML = '<section class="panel"><p class="muted">There are no bank accounts in the chart of accounts.</p></section>'; return; }
  const acc = d.accounts.find(a => a.id === accountId);
  const p = hashParams();
  const st = { tab: p.get("tab") || "match", open: null, cand: null, lines: [], search: "" };
  const manage = d.can.manage;
  const tabs = [["match", `To match${acc.toMatch ? ` (${acc.toMatch})` : ""}`], ["matched", "Matched"], ["excluded", "Excluded"], ["reconcile", "Reconcile"], ["history", "History"]];
  const coding = d.codingAccounts.filter(a => a.id !== accountId);
  const taxFor = acct => d.codingAccounts.find(a => a.id === acct)?.defaultTaxCodeId || "";

  const head = () => `
    <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Reconciliation</h1>
      <div class="toolbar inline"><div class="fld"><label for="rc-acc">Bank account</label><select id="rc-acc">${options(d.accounts.map(a => [a.id, `${a.code} ${a.name}`]), accountId)}</select></div></div></div>
      <div class="top-actions">${manage ? `<a class="btn primary" href="#/bank-accounts/${safe(accountId)}/import">Import statement</a>` : ""}</div></header>
    <div class="cards figures">
      <section class="card"><h2>Ledger balance today</h2><p class="big mono">${money(acc.ledgerBalance)}</p></section>
      <section class="card"><h2>Statement balance</h2><p class="big mono">${acc.statementBalance == null ? "—" : money(acc.statementBalance)}</p><p class="muted small">${acc.statementDate ? `at ${date(acc.statementDate)}` : "No file with a balance yet"}</p></section>
      <section class="card"><h2>Reconciled to</h2><p class="big">${acc.lastReconciled ? date(acc.lastReconciled) : "—"}</p><p class="muted small">${acc.lastReconciled ? money(acc.reconciledBalance) : "Not reconciled yet"}</p></section>
    </div>
    ${p.get("imported") ? `<p class="note">Imported ${safe(p.get("imported"))} new line(s)${Number(p.get("skipped")) ? `; ${safe(p.get("skipped"))} already here were skipped` : ""}.</p>` : ""}
    ${Number(p.get("early")) ? `<p class="note bad-text">${safe(p.get("early"))} new line(s) are dated on or before ${date(p.get("rec"))}, when this account was last reconciled. That reconciliation missed them, or they're duplicates with different wording: check them, then match or exclude them.</p>` : ""}
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === st.tab}" class="${k === st.tab ? "on" : ""}" data-tab="${k}">${safe(l)}</button>`).join("")}</div>`;

  const suggestionLabel = s => s.type === "match" ? `Match ${s.label}` : s.type === "invoice" ? `Receipt for ${s.label}${s.amount < s.owing ? ` (part of ${money(s.owing)})` : ""}`
    : s.type === "bill" ? `Pay ${s.label}` : s.type === "payrun" ? `Paid: ${s.label}` : `Rule: ${s.label}`;

  const panel = l => {
    const c = st.cand;
    if (!c) return '<p class="muted">Loading…</p>';
    const abs = Math.abs(l.amount);
    return `<div class="grid2 align-top">
      <form data-match-form><h3>Match to entries already in the ledger</h3>
        ${c.ledger.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${c.ledger.slice(0, 40).map(x => `<tr><td><label class="check"><input type="checkbox" name="ml" value="${safe(x.lineId)}" data-amt="${x.amount}" ${x.amount === l.amount && c.ledger.filter(y => y.amount === l.amount).length === 1 ? "checked" : ""}>
          ${date(x.date)} <a href="#/journals/${safe(x.journalId)}">${safe(x.number)}</a></label><small>${safe(SOURCE[x.source] || x.source)} · ${safe(x.memo)}</small></td><td class="num mono">${signed(x.amount)}</td></tr>`).join("")}</tbody></table></div>
          <p class="small">Selected: <strong data-msum>${money(0)}</strong> of ${money(l.amount)}</p>
          <div class="actions"><button class="btn primary" type="submit">Match</button></div>` : '<p class="muted small">Nothing in the ledger for this account within 60 days of this date.</p>'}
      </form>
      <form data-create-form><h3>${l.amount > 0 ? "Receive money" : "Spend money"}</h3>
        ${field({ id: "cr-payee", label: l.amount > 0 ? "From" : "Paid to", value: "", attrs: 'maxlength="120"' })}
        <div data-cr-lines>${[0].map(i => crLine(i, "", "", abs)).join("")}</div>
        <p class="small"><button type="button" class="link" data-cr-add>Split into another line</button> · Amounts include GST.</p>
        <div class="actions"><button class="btn primary" type="submit">Create and match</button></div>
      </form>
      ${l.amount > 0 ? `<form data-doc-form="invoice"><h3>Customer payment for invoices</h3>
        ${c.invoices.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${c.invoices.slice(0, 60).map(i => `<tr><td><label class="check"><input type="checkbox" name="doc" value="${safe(i.id)}" data-party="${safe(i.customerId)}" data-owing="${i.owing}">
          ${safe(i.number)} · ${safe(i.customer)}</label><small>Due ${date(i.due)}${i.reference ? ` · ${safe(i.reference)}` : ""}</small></td><td class="num mono">${money(i.owing)}</td></tr>`).join("")}</tbody></table></div>
          <p class="muted small">The amount is applied to the ticked invoices oldest first; anything over stays as credit for the customer.</p>
          <div class="actions"><button class="btn" type="submit">Record receipt and match</button></div>` : '<p class="muted small">No unpaid invoices.</p>'}</form>`
      : `<form data-doc-form="bill"><h3>Pay bills</h3>
        ${c.bills.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${c.bills.slice(0, 60).map(b => `<tr><td><label class="check"><input type="checkbox" name="doc" value="${safe(b.id)}" data-party="${safe(b.supplierId)}" data-owing="${b.owing}">
          ${safe(b.number)} · ${safe(b.supplier)}</label><small>Due ${date(b.due)}${b.reference ? ` · ${safe(b.reference)}` : ""}</small></td><td class="num mono">${money(b.owing)}</td></tr>`).join("")}</tbody></table></div>
          <p class="muted small">The ticked bills must add up to the amount paid.</p>
          <div class="actions"><button class="btn" type="submit">Record payment and match</button></div>` : '<p class="muted small">No unpaid bills.</p>'}</form>
      ${c.payRuns.length ? `<div><h3>Pay runs</h3>${c.payRuns.map(r => `<p><button type="button" class="btn" data-payrun="${safe(r.id)}" data-what="${r.what}">${safe(r.number)} ${r.what === "net" ? "net pay" : "super"} ${money(r.amount)}</button></p>`).join("")}</div>` : ""}`}
      <form data-exclude-form><h3>Exclude</h3><p class="muted small">For a line that doesn't belong in the books, such as a duplicate. It's kept, marked excluded.</p>
        ${field({ id: "ex-reason", label: "Reason", attrs: 'maxlength="300"' })}<div class="actions"><button class="btn danger" type="submit">Exclude</button></div></form>
    </div>`;
  };
  const crLine = (i, acct, tax, amt) => `<div class="grid3" data-cr-line>
    <div class="fld"><label for="cr-a-${i}">Account</label><select id="cr-a-${i}" name="acct">${accountOptions(coding, acct)}</select></div>
    <div class="fld"><label for="cr-t-${i}">Tax</label><select id="cr-t-${i}" name="tax"><option value="">No GST</option>${options(d.taxCodes.map(t => [t.id, `${t.code} ${t.name}`]), tax)}</select></div>
    ${field({ id: `cr-m-${i}`, label: "Amount", value: amt ? Number(amt).toFixed(2) : "", attrs: 'name="amt" inputmode="decimal"' })}</div>`;

  const matchTab = () => `
    <section class="panel">
      <div class="toolbar"><div class="fld"><label for="rc-search">Search</label><input id="rc-search" value="${safe(st.search)}" placeholder="Description"></div></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Statement line</th><th scope="col" class="num">Amount</th><th scope="col">Suggested</th><th scope="col"></th></tr></thead><tbody>
      ${st.lines.map(l => {
        const best = l.suggestions?.[0];
        return `<tr><td class="nowrap">${date(l.date)}</td><td>${safe(l.description)}${l.reference ? `<small>${safe(l.reference)}</small>` : ""}</td><td class="num mono">${signed(l.amount)}</td>
          <td>${best ? `<button type="button" class="btn" data-accept="${safe(l.id)}">${safe(suggestionLabel(best))}</button>${l.suggestions.length > 1 ? `<small>${l.suggestions.length - 1} other suggestion(s)</small>` : ""}` : '<span class="muted small">No suggestion</span>'}</td>
          <td class="row-acts">${manage ? `<button type="button" class="link" data-open="${safe(l.id)}">${st.open === l.id ? "Close" : "Other options"}</button>` : ""}</td></tr>
          ${st.open === l.id ? `<tr><td colspan="5">${l.suggestions?.length > 1 ? `<p>${l.suggestions.slice(1).map((s, i) => `<button type="button" class="btn" data-accept="${safe(l.id)}" data-n="${i + 1}">${safe(suggestionLabel(s))}</button>`).join(" ")}</p>` : ""}${panel(l)}</td></tr>` : ""}`;
      }).join("") || `<tr><td colspan="5" class="muted">${st.search ? "No lines match that search." : "Every imported line is matched or excluded."}</td></tr>`}
      </tbody></table></div>
      ${st.lines.length >= 500 ? '<p class="muted small">Showing the first 500 lines.</p>' : ""}
    </section>`;

  const doneTab = () => `<section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Date</th><th scope="col">Statement line</th><th scope="col" class="num">Amount</th>
      <th scope="col">${st.tab === "matched" ? "Matched to" : "Reason"}</th><th scope="col"></th></tr></thead><tbody>
    ${st.lines.map(l => `<tr><td class="nowrap">${date(l.date)}</td><td>${safe(l.description)}</td><td class="num mono">${signed(l.amount)}</td>
      <td>${st.tab === "matched" ? (l.matchedTo || []).map(j => `<a href="#/journals/${safe(j.id)}">${safe(j.number)}</a> <small>${safe(SOURCE[j.source] || j.source)} · ${safe(j.memo)}</small>`).join("") : safe(l.excludedReason)}</td>
      <td class="row-acts">${l.reconciled ? chip("Reconciled", "good") : manage ? `<button type="button" class="link" data-unmatch="${safe(l.id)}" data-kind="${safe(l.matchKind || "")}">${st.tab === "matched" ? "Unmatch" : "Restore"}</button>` : ""}</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">Nothing here.</td></tr>'}
    </tbody></table></div></section>`;

  const reconcileTab = async () => {
    const asAt = st.recDate || (acc.statementDate && (!acc.lastReconciled || acc.statementDate > acc.lastReconciled) ? acc.statementDate : today());
    st.recDate = asAt;
    const pv = await call("bank_reconcile_preview", { accountId, date: asAt, clearedBefore: st.clearedBefore || "" });
    if (st.recBalance == null && pv.statementBalanceFromFile != null) st.recBalance = String(pv.statementBalanceFromFile);
    if (pv.firstReconciliation && st.clearedBefore == null) st.clearedBefore = "";
    const entered = Number(String(st.recBalance ?? "").replace(/[$,\s]/g, ""));
    const diff = Number.isFinite(entered) && st.recBalance !== "" && st.recBalance != null ? Math.round((entered - pv.expectedStatementBalance) * 100) / 100 : null;
    return `<section class="panel"><form data-reconcile>
      <div class="grid3">
        ${field({ id: "rec-date", label: "Statement date", type: "date", value: asAt })}
        ${field({ id: "rec-bal", label: "Closing balance on the statement", value: st.recBalance ?? "", attrs: 'inputmode="decimal"' })}
        ${pv.firstReconciliation ? field({ id: "rec-cut", label: "Entries before this date are already through the bank", type: "date", value: st.clearedBefore || "",
          hint: "First reconciliation only: usually the first day of the first statement you imported" }) : ""}
      </div>
      ${pv.lastReconciled ? `<p class="muted small">Last reconciled to ${date(pv.lastReconciled)}.</p>` : ""}
      <table class="tbl recon-sum"><tbody>
        <tr><th scope="row">Ledger balance at ${date(asAt)}</th><td class="num mono">${money(pv.ledgerBalance)}</td></tr>
        ${pv.clearedAsOpening ? `<tr><th scope="row">Earlier entries treated as through the bank</th><td class="num mono">${money(pv.clearedAsOpening)}</td></tr>` : ""}
        <tr><th scope="row">Less: entries not yet through the bank (${pv.itemCount})</th><td class="num mono">${money(-pv.unpresented)}</td></tr>
        ${pv.recordedEarly ? `<tr><th scope="row">Add: in the bank by then, entered after it</th><td class="num mono">${money(pv.recordedEarly)}</td></tr>` : ""}
        <tr><th scope="row"><strong>The statement should show</strong></th><td class="num mono"><strong>${money(pv.expectedStatementBalance)}</strong></td></tr>
        ${diff != null ? `<tr><th scope="row">Difference</th><td class="num mono ${diff ? "bad-text" : ""}">${money(diff)}</td></tr>` : ""}
      </tbody></table>
      ${pv.openLines ? `<p class="note">${pv.openLines} statement line(s) up to this date still need matching or excluding.</p>` : ""}
      ${diff ? '<p class="note">Out of balance. Look for statement lines not imported, entries dated in the wrong month, or a wrong amount in the ledger.</p>' : ""}
      ${field({ id: "rec-notes", label: "Notes (optional)", attrs: 'maxlength="1000"' })}
      ${manage ? `<div class="actions"><button class="btn primary" type="submit" ${pv.openLines || diff ? "disabled" : ""}>Complete reconciliation</button></div>` : ""}
    </form></section>
    ${pv.items.length ? `<section class="panel"><h2>Not yet through the bank at ${date(asAt)}</h2><div class="tbl-wrap"><table class="tbl"><tbody>
      ${pv.items.map(x => `<tr><td class="nowrap">${date(x.date)}</td><td><a href="#/journals/${safe(x.journalId)}">${safe(x.number)}</a> <small>${safe(SOURCE[x.source] || x.source)} · ${safe(x.memo)}</small></td><td class="num mono">${signed(x.amount)}</td></tr>`).join("")}
      ${pv.itemCount > pv.items.length ? `<tr><td colspan="3" class="muted">and ${pv.itemCount - pv.items.length} more</td></tr>` : ""}</tbody></table></div></section>` : ""}`;
  };

  const historyTab = async () => {
    const h = await call("bank_reconciliations", { accountId });
    return `<section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Statement date</th><th scope="col" class="num">Balance</th><th scope="col" class="num">Unpresented</th><th scope="col">By</th><th scope="col">Status</th></tr></thead><tbody>
      ${h.reconciliations.map(r => `<tr><td><a href="#/reconciliation/report/${safe(r.id)}">${date(r.date)}</a></td><td class="num mono">${money(r.balance)}</td><td class="num mono">${money(r.unpresented)}</td>
        <td>${safe(r.by)} ${dateTime(r.at)}</td><td>${r.status === "completed" ? chip("Completed", "good") : `${chip("Undone")}<small>${safe(r.undoReason || "")}</small>`}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No reconciliations yet.</td></tr>'}
    </tbody></table></div></section>`;
  };

  const load = async () => {
    let body = "";
    if (["match", "matched", "excluded"].includes(st.tab)) {
      const r = await call("bank_lines", { accountId, status: st.tab === "match" ? "new" : st.tab, search: st.search });
      st.lines = r.lines;
      body = st.tab === "match" ? matchTab() : doneTab();
    } else if (st.tab === "reconcile") body = await reconcileTab();
    else body = await historyTab();
    view.innerHTML = head() + body + '<p class="msg" data-msg role="status" aria-live="polite"></p>';
    if (st.open && st.cand) sumMatch();
  };
  const sumMatch = () => {
    const el = view.querySelector("[data-msum]");
    if (!el) return;
    const t = [...view.querySelectorAll("[name=ml]:checked")].reduce((s, x) => s + Math.round(Number(x.dataset.amt) * 100), 0) / 100;
    el.textContent = money(t);
  };
  const refresh = async (msg) => {
    st.open = null; st.cand = null;
    const o = await call("banking_overview");
    Object.assign(acc, o.accounts.find(a => a.id === accountId));
    tabs[0][1] = `To match${acc.toMatch ? ` (${acc.toMatch})` : ""}`;
    await load();
    if (msg) flash(view, msg, "good");
  };
  const accept = async (line, s) => {
    if (s.type === "match") await call("bank_match", { id: line.id, lineIds: s.lineIds });
    else if (s.type === "invoice") await call("bank_receive_payment", { id: line.id, customerId: s.customerId, allocations: [{ invoiceId: s.invoiceId, amount: s.amount }] });
    else if (s.type === "bill") await call("bank_pay_bills", { id: line.id, supplierId: s.supplierId, allocations: [{ billId: s.billId, amount: s.amount }] });
    else if (s.type === "payrun") await call("bank_pay_run", { id: line.id, runId: s.runId, what: s.what });
    else if (s.type === "rule") await call("bank_create_entry", { id: line.id, payee: s.payee, lines: [{ accountId: s.accountId, taxCodeId: s.taxCodeId, amount: Math.abs(line.amount) }] });
  };

  await load();

  view.addEventListener("change", async e => {
    const t = e.target;
    try {
      if (t.id === "rc-acc") location.hash = `#/reconciliation/${t.value}`;
      else if (t.id === "rc-search") { st.search = t.value.trim(); await load(); }
      else if (t.name === "ml") sumMatch();
      else if (t.name === "acct") { const tax = t.closest("[data-cr-line]").querySelector("[name=tax]"); tax.value = taxFor(t.value); }
      else if (t.id === "rec-date") { st.recDate = t.value; await load(); }
      else if (t.id === "rec-bal") { st.recBalance = t.value; await load(); }
      else if (t.id === "rec-cut") { st.clearedBefore = t.value; await load(); }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-tab]");
    const open = e.target.closest("[data-open]");
    const acc2 = e.target.closest("[data-accept]");
    const un = e.target.closest("[data-unmatch]");
    const add = e.target.closest("[data-cr-add]");
    const pr = e.target.closest("[data-payrun]");
    try {
      if (tab) { st.tab = tab.dataset.tab; st.open = null; await load(); }
      else if (open) {
        st.open = st.open === open.dataset.open ? null : open.dataset.open; st.cand = null; await load();
        if (st.open) { st.cand = await call("bank_line_candidates", { id: st.open }); await load(); }
      } else if (acc2) {
        const line = st.lines.find(l => l.id === acc2.dataset.accept);
        const s = line.suggestions[Number(acc2.dataset.n || 0)];
        acc2.disabled = true;
        await accept(line, s);
        await refresh("Matched.");
      } else if (un) {
        const created = un.dataset.kind === "created";
        if (st.tab === "matched" && !window.confirm(created ? "Unmatch this line? An entry made from it is reversed; a receipt or payment recorded from it stays (void it in its own screen if it's wrong)." : "Unmatch this line?")) return;
        await call("bank_unmatch", { id: un.dataset.unmatch });
        await refresh(st.tab === "matched" ? "Unmatched." : "Restored to the lines to match.");
      } else if (add) {
        const box = view.querySelector("[data-cr-lines]");
        const n = box.querySelectorAll("[data-cr-line]").length;
        if (n < 5) box.insertAdjacentHTML("beforeend", crLine(n, "", "", 0));
      } else if (pr) {
        await call("bank_pay_run", { id: st.open, runId: pr.dataset.payrun, what: pr.dataset.what });
        await refresh("Recorded and matched.");
      }
    } catch (error) { if (acc2) acc2.disabled = false; flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target;
    const line = st.lines.find(l => l.id === st.open);
    try {
      if (f.matches("[data-match-form]")) {
        const ids = [...f.querySelectorAll("[name=ml]:checked")].map(x => x.value);
        await call("bank_match", { id: line.id, lineIds: ids });
        await refresh("Matched.");
      } else if (f.matches("[data-create-form]")) {
        const ls = [...f.querySelectorAll("[data-cr-line]")].map(r => ({ accountId: r.querySelector("[name=acct]").value, taxCodeId: r.querySelector("[name=tax]").value,
          amount: r.querySelector("[name=amt]").value.replace(/[$,\s]/g, "") })).filter(x => x.accountId || x.amount);
        await call("bank_create_entry", { id: line.id, payee: f.querySelector("#cr-payee").value, lines: ls });
        await refresh("Created and matched.");
      } else if (f.matches("[data-doc-form]")) {
        const ticked = [...f.querySelectorAll("[name=doc]:checked")];
        if (!ticked.length) return flash(view, "Tick at least one.", "bad");
        const parties = new Set(ticked.map(x => x.dataset.party));
        if (parties.size > 1) return flash(view, `Tick ${f.dataset.docForm === "invoice" ? "invoices" : "bills"} for one ${f.dataset.docForm === "invoice" ? "customer" : "supplier"} at a time.`, "bad");
        let left = Math.round(Math.abs(line.amount) * 100);
        const allocations = ticked.map(x => { const owe = Math.round(Number(x.dataset.owing) * 100); const a = Math.min(owe, left); left -= a; return { id: x.value, amount: a / 100 }; }).filter(a => a.amount > 0);
        if (f.dataset.docForm === "invoice") await call("bank_receive_payment", { id: line.id, customerId: [...parties][0], allocations: allocations.map(a => ({ invoiceId: a.id, amount: a.amount })) });
        else {
          if (left !== 0) return flash(view, "The ticked bills don't add up to the amount paid.", "bad");
          await call("bank_pay_bills", { id: line.id, supplierId: [...parties][0], allocations: allocations.map(a => ({ billId: a.id, amount: a.amount })) });
        }
        await refresh("Recorded and matched.");
      } else if (f.matches("[data-exclude-form]")) {
        await call("bank_exclude", { id: line.id, reason: f.querySelector("#ex-reason").value });
        await refresh("Excluded.");
      } else if (f.matches("[data-reconcile]")) {
        if (!window.confirm(`Complete the reconciliation to ${date(st.recDate)}? Lines up to then are locked; you can undo it later with a reason.`)) return;
        await call("bank_reconcile", { accountId, date: f.querySelector("#rec-date").value, balance: f.querySelector("#rec-bal").value,
          clearedBefore: f.querySelector("#rec-cut")?.value || "", notes: f.querySelector("#rec-notes").value });
        st.tab = "history"; st.recBalance = null; st.recDate = null; st.clearedBefore = null;
        await refresh("Reconciled.");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

async function report(view, id) {
  const r = await call("bank_reconciliation_get", { id });
  const x = r.reconciliation;
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Bank reconciliation</h1>
      <p class="muted">${safe(r.account.code)} ${safe(r.account.name)} · statement ${date(x.date)}</p></div>
      <div class="top-actions"><a class="btn" href="#/reconciliation/${safe(r.account.id)}?tab=history">Back</a> <button type="button" class="btn" data-print>Print</button></div></header>
    <section class="panel">
      ${x.status === "undone" ? `<p class="note">Undone by ${safe(x.undoneBy)}: ${safe(x.undoReason)}</p>` : ""}
      <table class="tbl recon-sum"><tbody>
        <tr><th scope="row">Balance per statement</th><td class="num mono">${money(x.balance)}</td></tr>
        <tr><th scope="row">Add: entries not yet through the bank</th><td class="num mono">${money(x.unpresented)}</td></tr>
        ${x.recordedEarly ? `<tr><th scope="row">Less: in the bank, entered after the date</th><td class="num mono">${money(-x.recordedEarly)}</td></tr>` : ""}
        <tr><th scope="row"><strong>Balance per ledger</strong></th><td class="num mono"><strong>${money(x.ledgerBalance)}</strong></td></tr>
      </tbody></table>
      <p class="muted small">Completed by ${safe(x.by)} ${dateTime(x.at)}${x.clearedBefore ? `. Entries before ${date(x.clearedBefore)} were treated as already through the bank` : ""}.${x.notes ? ` ${safe(x.notes)}` : ""}</p>
      ${r.can.undo ? '<div class="actions"><button type="button" class="btn danger" data-undo-rec>Undo this reconciliation</button></div>' : ""}
    </section>
    ${r.unpresentedItems.length ? `<section class="panel"><h2>Not through the bank at ${date(x.date)}</h2><div class="tbl-wrap"><table class="tbl"><tbody>
      ${r.unpresentedItems.map(u => `<tr><td class="nowrap">${date(u.date)}</td><td><a href="#/journals/${safe(u.journalId)}">${safe(u.number)}</a> <small>${safe(SOURCE[u.source] || u.source)} · ${safe(u.memo)}</small></td><td class="num mono">${signed(u.amount)}</td></tr>`).join("")}
    </tbody></table></div></section>` : ""}
    <section class="panel"><h2>Statement lines reconciled (${r.statementLines.length})</h2><div class="tbl-wrap"><table class="tbl"><tbody>
      ${r.statementLines.map(l => `<tr><td class="nowrap">${date(l.date)}</td><td>${safe(l.description)}${l.status === "excluded" ? `<small>Excluded: ${safe(l.excludedReason)}</small>` : ""}</td><td class="num mono">${signed(l.amount)}</td></tr>`).join("")}
    </tbody></table></div></section>
    <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  view.addEventListener("click", async e => {
    if (e.target.closest("[data-print]")) return window.print();
    if (!e.target.closest("[data-undo-rec]")) return;
    const reason = window.prompt("Undo this reconciliation? Its lines unlock. Say why:", "");
    if (reason === null) return;
    try { await call("bank_reconcile_undo", { id, reason }); location.hash = `#/reconciliation/${r.account.id}?tab=history`; }
    catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Bank rules ---------------- */

export async function renderBankRules(view) {
  const d = await call("banking_overview");
  const st = { edit: null };
  const acctName = id => { const a = d.codingAccounts.find(x => x.id === id); return a ? `${a.code} ${a.name}` : ""; };
  const taxName = id => d.taxCodes.find(t => t.id === id)?.code || "No GST";
  const form = r => `<form class="panel" data-rule-form>
    <h2>${r?.id ? "Edit rule" : "New rule"}</h2>
    <div class="grid3">
      ${field({ id: "ru-name", label: "Name", value: r?.name || "", attrs: 'maxlength="80"' })}
      ${field({ id: "ru-text", label: "When the description contains", value: r?.matchText || "", attrs: 'maxlength="100"', hint: "Not case-sensitive" })}
      <div class="fld"><label for="ru-dir">Money</label><select id="ru-dir">${options([["any", "In or out"], ["out", "Out"], ["in", "In"]], r?.direction || "out")}</select></div>
      <div class="fld"><label for="ru-bank">Bank account</label><select id="ru-bank"><option value="">Any</option>${options(d.accounts.map(a => [a.id, `${a.code} ${a.name}`]), r?.bankAccountId)}</select></div>
      ${field({ id: "ru-min", label: "Amount from (optional)", value: r?.amountMin ?? "", attrs: 'inputmode="decimal"' })}
      ${field({ id: "ru-max", label: "Amount to (optional)", value: r?.amountMax ?? "", attrs: 'inputmode="decimal"' })}
      <div class="fld"><label for="ru-acc">Code to</label><select id="ru-acc">${accountOptions(d.codingAccounts.filter(a => a.subtype !== "bank"), r?.targetAccountId)}</select></div>
      <div class="fld"><label for="ru-tax">Tax</label><select id="ru-tax"><option value="">No GST</option>${options(d.taxCodes.map(t => [t.id, `${t.code} ${t.name}`]), r?.taxCodeId)}</select></div>
      ${field({ id: "ru-payee", label: "Payee", value: r?.payee || "", attrs: 'maxlength="120"' })}
      ${field({ id: "ru-pri", label: "Order", value: r?.priority ?? 100, attrs: 'inputmode="numeric"', hint: "Lower numbers are tried first" })}
    </div>
    <label class="check"><input type="checkbox" id="ru-active" ${r?.active === false ? "" : "checked"}> Active</label>
    <div class="actions"><button class="btn primary" type="submit">Save rule</button> <button type="button" class="btn" data-cancel>Cancel</button>
      ${r?.id ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ""}</div></form>`;
  const draw = () => {
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">BANKING</p><h1>Bank rules</h1>
        <p class="muted">Rules suggest how to code repeating statement lines (fuel, bank fees, phone). Each suggestion is still accepted by a person.</p></div>
        <button type="button" class="btn primary" data-new>New rule</button></header>
      ${st.edit !== null ? form(st.edit === "new" ? null : d.rules.find(r => r.id === st.edit)) : ""}
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Order</th><th scope="col">Rule</th><th scope="col">When</th><th scope="col">Code to</th><th scope="col"></th></tr></thead><tbody>
        ${d.rules.map(r => `<tr><td class="num">${r.priority}</td><td><strong>${safe(r.name)}</strong>${r.active ? "" : ` ${chip("Off")}`}${r.payee ? `<small>${safe(r.payee)}</small>` : ""}</td>
          <td>"${safe(r.matchText)}" · ${r.direction === "any" ? "in or out" : r.direction}${r.amountMin != null || r.amountMax != null ? ` · ${r.amountMin != null ? money(r.amountMin) : "any"} to ${r.amountMax != null ? money(r.amountMax) : "any"}` : ""}</td>
          <td>${safe(acctName(r.targetAccountId))} <small>${safe(taxName(r.taxCodeId))}</small></td><td><button type="button" class="link" data-edit="${safe(r.id)}">Edit</button></td></tr>`).join("")
          || '<tr><td colspan="5" class="muted">No rules yet.</td></tr>'}
      </tbody></table></div></section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  draw();
  const reload = async msg => { Object.assign(d, await call("banking_overview")); st.edit = null; draw(); if (msg) flash(view, msg, "good"); };
  view.addEventListener("change", e => {
    if (e.target.id === "ru-acc") view.querySelector("#ru-tax").value = d.codingAccounts.find(a => a.id === e.target.value)?.defaultTaxCodeId || "";
  });
  view.addEventListener("click", async e => {
    try {
      if (e.target.closest("[data-new]")) { st.edit = "new"; draw(); }
      else if (e.target.closest("[data-edit]")) { st.edit = e.target.closest("[data-edit]").dataset.edit; draw(); }
      else if (e.target.closest("[data-cancel]")) { st.edit = null; draw(); }
      else if (e.target.closest("[data-delete]")) {
        if (!window.confirm("Delete this rule?")) return;
        await call("bank_rule_delete", { id: st.edit }); await reload("Deleted.");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-rule-form]")) return;
    e.preventDefault();
    const v = id => view.querySelector(`#${id}`).value.trim();
    try {
      await call("bank_rule_save", { id: st.edit === "new" ? null : st.edit, name: v("ru-name"), matchText: v("ru-text"), direction: v("ru-dir"), bankAccountId: v("ru-bank"),
        amountMin: v("ru-min"), amountMax: v("ru-max"), targetAccountId: v("ru-acc"), taxCodeId: v("ru-tax"), payee: v("ru-payee"), priority: v("ru-pri"),
        active: view.querySelector("#ru-active").checked });
      await reload("Rule saved.");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
