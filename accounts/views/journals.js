// Journals: list, editor (drafts) and detail (post, delete, reverse).
// Routes: #/journals, #/journals/new, #/journals/<id>, #/journals/<id>/edit
import { call, chip, date, dateTime, flash, friendlyError, hashParams, money, options, parseMoney, safe, today, TYPE_LABEL, TYPE_ORDER } from "../lib/ui.js";
import { journalTotals, lineGst } from "../lib/validate.js";

const STATUS = { draft: ["Draft", "pending"], posted: ["Posted", "good"], reversed: ["Reversed", ""] };
const SOURCE = { manual: "Manual journal" };

export async function renderJournals(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("/");
  if (id === "new") return editor(view, null);
  if (id && mode === "edit") return editor(view, id);
  if (id) return detail(view, id);
  return list(view);
}

/* ---------------- List ---------------- */

async function list(view) {
  const p = hashParams();
  const f = { status: p.get("status") || "", from: p.get("from") || "", to: p.get("to") || "", search: p.get("q") || "", page: 1 };
  const setup = await call("ledger_setup");
  const load = async () => {
    const d = await call("journals_list", f);
    const pages = d.total ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING</p><h1>Journals</h1>
        <p class="muted">Every posted entry in the general ledger. Posted journals can't be edited or deleted; correct them with a reversal and a new journal.</p></div>
        ${setup.can.journal ? '<a class="btn primary" href="#/journals/new">New journal</a>' : ""}</header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="j-st">Status</label><select id="j-st">${options([["", "All"], ["draft", "Draft"], ["posted", "Posted"], ["reversed", "Reversed"]], f.status)}</select></div>
          <div class="fld"><label for="j-from">From</label><input id="j-from" type="date" value="${safe(f.from)}"></div>
          <div class="fld"><label for="j-to">To</label><input id="j-to" type="date" value="${safe(f.to)}"></div>
          <div class="fld"><label for="j-q">Narration contains</label><input id="j-q" value="${safe(f.search)}"></div>
          <button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Narration</th><th scope="col">Source</th><th scope="col" class="num">Amount</th><th scope="col">Status</th></tr></thead><tbody>
          ${d.journals.map(j => { const [l, t] = STATUS[j.status]; return `<tr>
            <td class="mono"><a href="#/journals/${safe(j.id)}">${safe(j.number || "Draft")}</a></td><td class="nowrap">${date(j.date)}</td>
            <td>${safe(j.memo || "—")}${j.isReversal ? ` ${chip("Reversal", "info")}` : ""}<small>${j.createdBy ? `by ${safe(j.createdBy)}` : ""}</small></td>
            <td>${safe(j.sourceRef || SOURCE[j.source] || j.source)}</td><td class="num mono">${money(j.total)}</td><td>${chip(l, t)}</td></tr>`; }).join("")
            || '<tr><td colspan="6" class="muted">No journals match.</td></tr>'}
        </tbody></table></div>
        <div class="pager"><button type="button" class="btn" data-page="-1" ${f.page <= 1 ? "disabled" : ""}>Newer</button>
          <span class="muted small">Page ${f.page} of ${pages}</span><button type="button" class="btn" data-page="1" ${f.page >= pages ? "disabled" : ""}>Older</button></div>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    Object.assign(f, { status: view.querySelector("#j-st").value, from: view.querySelector("#j-from").value, to: view.querySelector("#j-to").value, search: view.querySelector("#j-q").value.trim(), page: 1 });
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const b = e.target.closest("[data-page]");
    if (!b) return;
    f.page = Math.max(1, f.page + Number(b.dataset.page));
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Editor ---------------- */

async function editor(view, id) {
  const setup = await call("ledger_setup");
  const accounts = setup.accounts.filter(a => a.status === "active" && a.allowManual);
  const taxes = setup.taxCodes.filter(t => t.active);
  const rates = Object.fromEntries(setup.taxCodes.map(t => [t.id, t.rate]));
  let j = { date: today(), memo: "", amountsAre: "exclusive", lines: [blank(), blank()] };
  if (id) {
    const d = await call("journal_get", { id });
    if (d.journal.status !== "draft") { location.hash = `#/journals/${id}`; return; }
    j = { id, date: d.journal.date, memo: d.journal.memo, amountsAre: d.journal.amountsAre,
      lines: d.lines.filter(l => !l.isTaxLine).map(l => ({ accountId: l.accountId, description: l.description, taxCodeId: l.taxCodeId || "",
        debit: l.debit ? String(l.enteredAmount ?? l.debit) : "", credit: l.credit ? String(l.enteredAmount ?? l.credit) : "" })) };
  }
  function blank() { return { accountId: "", description: "", taxCodeId: "", debit: "", credit: "" }; }
  const accountOptions = sel => `<option value="">Choose an account…</option>${TYPE_ORDER.map(t => {
    const rows = accounts.filter(a => a.type === t);
    return rows.length ? `<optgroup label="${safe(TYPE_LABEL[t])}">${rows.map(a => `<option value="${safe(a.id)}" ${a.id === sel ? "selected" : ""}>${safe(a.code)} ${safe(a.name)}</option>`).join("")}</optgroup>` : "";
  }).join("")}`;

  const draw = () => {
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING · JOURNALS</p><h1>${id ? "Edit draft journal" : "New journal"}</h1>
        <p class="muted">Enter amounts as debits and credits. Lines with a GST code get a GST line added to 2300 when posted. Receivables, payables and current year earnings take entries only from their own modules.</p></div></header>
      <form class="panel" data-journal>
        <div class="grid3">
          <div class="fld"><label for="je-date">Date</label><input id="je-date" type="date" value="${safe(j.date)}" required></div>
          <div class="fld"><label for="je-amounts">Amounts are</label><select id="je-amounts">${options([["exclusive", "Tax exclusive (GST added)"], ["inclusive", "Tax inclusive (GST included)"], ["no_tax", "No tax"]], j.amountsAre)}</select></div>
          <div class="fld"><label for="je-memo">Narration</label><input id="je-memo" value="${safe(j.memo)}" maxlength="500" placeholder="What this journal is for"></div>
        </div>
        <div class="tbl-wrap"><table class="tbl lines"><thead><tr><th scope="col">Account</th><th scope="col">Description</th><th scope="col">Tax</th>
          <th scope="col" class="num">Debit</th><th scope="col" class="num">Credit</th><th scope="col" class="num">GST</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody>
          ${j.lines.map((l, i) => `<tr data-line="${i}">
            <td><select aria-label="Account, line ${i + 1}" data-f="accountId">${accountOptions(l.accountId)}</select></td>
            <td><input aria-label="Description, line ${i + 1}" data-f="description" value="${safe(l.description)}" maxlength="300"></td>
            <td><select aria-label="Tax code, line ${i + 1}" data-f="taxCodeId" ${j.amountsAre === "no_tax" ? "disabled" : ""}>${options([["", "—"], ...taxes.map(t => [t.id, t.code])], l.taxCodeId)}</select></td>
            <td><input aria-label="Debit, line ${i + 1}" data-f="debit" class="num" inputmode="decimal" value="${safe(l.debit)}"></td>
            <td><input aria-label="Credit, line ${i + 1}" data-f="credit" class="num" inputmode="decimal" value="${safe(l.credit)}"></td>
            <td class="num mono muted" data-gst></td>
            <td><button type="button" class="link" data-remove="${i}" aria-label="Remove line ${i + 1}" ${j.lines.length <= 2 ? "disabled" : ""}>✕</button></td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="3"><button type="button" class="link" data-add-line>+ Add a line</button></td>
          <td class="num mono" data-tdr></td><td class="num mono" data-tcr></td><td colspan="2"></td></tr></tfoot></table></div>
        <p class="balance" data-balance></p>
        <div class="actions">
          <button class="btn" type="submit" data-save="draft">Save draft</button>
          ${setup.can.post ? '<button class="btn primary" type="submit" data-save="post">Save and post</button>' : '<span class="muted small">Someone with "Approve and post journals" will post it.</span>'}
          <a class="btn" href="#/journals${id ? `/${id}` : ""}">Cancel</a></div>
      </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
    totals();
  };

  const read = () => {
    j.date = view.querySelector("#je-date").value;
    j.memo = view.querySelector("#je-memo").value;
    j.amountsAre = view.querySelector("#je-amounts").value;
    view.querySelectorAll("[data-line]").forEach(row => {
      const l = j.lines[Number(row.dataset.line)];
      row.querySelectorAll("[data-f]").forEach(el => { l[el.dataset.f] = el.value; });
    });
  };

  const totals = () => {
    read();
    let bad = false;
    const parsed = j.lines.map((l, i) => {
      const dr = parseMoney(l.debit), cr = parseMoney(l.credit);
      const row = view.querySelector(`[data-line="${i}"]`);
      row.querySelector('[data-f="debit"]').classList.toggle("invalid", Number.isNaN(dr));
      row.querySelector('[data-f="credit"]').classList.toggle("invalid", Number.isNaN(cr));
      if (Number.isNaN(dr) || Number.isNaN(cr)) bad = true;
      const amount = (dr || 0) || (cr || 0);
      row.querySelector("[data-gst]").textContent = money(lineGst(amount, rates[l.taxCodeId] || 0, j.amountsAre), { blankZero: true });
      return { debit: dr || 0, credit: cr || 0, taxCodeId: l.taxCodeId };
    });
    const t = journalTotals(parsed, rates, j.amountsAre);
    view.querySelector("[data-tdr]").textContent = money(t.debit);
    view.querySelector("[data-tcr]").textContent = money(t.credit);
    const diff = Math.round((t.debit - t.credit) * 100) / 100;
    const el = view.querySelector("[data-balance]");
    el.className = `balance ${bad || diff ? "bad" : t.debit ? "good" : ""}`;
    el.textContent = bad ? "Amounts must be numbers with up to 2 decimal places." : diff ? `Out of balance by ${money(Math.abs(diff))} (${diff > 0 ? "more debits" : "more credits"}).` : t.debit ? "Balanced, including GST." : "";
  };

  draw();
  const err = hashParams().get("err");
  if (err) flash(view, `Saved as a draft but not posted: ${err}`, "bad");
  view.addEventListener("input", e => { if (e.target.closest("[data-line]") || e.target.id === "je-amounts") totals(); });
  view.addEventListener("change", e => {
    if (e.target.id === "je-amounts") { read(); draw(); return; }
    const f = e.target.dataset.f;
    if (f === "accountId") {
      const row = e.target.closest("[data-line]");
      const acc = accounts.find(a => a.id === e.target.value);
      const tax = row.querySelector('[data-f="taxCodeId"]');
      if (acc && !tax.value) tax.value = acc.defaultTaxCodeId || "";
    }
    if (f === "debit" || f === "credit") {
      const row = e.target.closest("[data-line]");
      const other = row.querySelector(`[data-f="${f === "debit" ? "credit" : "debit"}"]`);
      if (e.target.value.trim()) other.value = "";
    }
    totals();
  });
  view.addEventListener("click", e => {
    if (e.target.closest("[data-add-line]")) { read(); j.lines.push(blank()); draw(); view.querySelector(`[data-line="${j.lines.length - 1}"] select`).focus(); }
    const r = e.target.closest("[data-remove]");
    if (r) { read(); j.lines.splice(Number(r.dataset.remove), 1); draw(); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-journal]")) return;
    e.preventDefault();
    read();
    const post = e.submitter?.dataset.save === "post";
    const lines = j.lines.filter(l => l.accountId || l.debit || l.credit).map(l => ({ ...l, debit: parseMoney(l.debit) || 0, credit: parseMoney(l.credit) || 0 }));
    if (lines.some(l => Number.isNaN(l.debit) || Number.isNaN(l.credit))) return flash(view, "Fix the highlighted amounts first.", "bad");
    view.querySelectorAll("button[type=submit]").forEach(b => { b.disabled = true; });
    try {
      const r = await call("journal_save", { id: j.id || null, date: j.date, memo: j.memo, amountsAre: j.amountsAre, lines, post });
      if (r.postError) {
        location.hash = `#/journals/${r.id}/edit?err=${encodeURIComponent(r.postError)}`;
        return;
      }
      location.hash = `#/journals/${r.id}`;
    } catch (error) {
      flash(view, friendlyError(error), "bad");
      view.querySelectorAll("button[type=submit]").forEach(b => { b.disabled = false; });
    }
  });
}

/* ---------------- Detail ---------------- */

async function detail(view, id) {
  const load = async () => {
    const { journal: j, lines, can } = await call("journal_get", { id });
    const [label, tone] = STATUS[j.status];
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING · JOURNALS</p><h1>${safe(j.number || "Draft journal")} ${chip(label, tone)}</h1>
        <p class="muted">${safe(j.memo || "No narration")}</p></div>
        <a class="btn" href="#/journals">All journals</a></header>
      <section class="panel">
        <dl class="facts">
          <dt>Date</dt><dd>${date(j.date)}</dd>
          <dt>Source</dt><dd>${safe(j.sourceRef || SOURCE[j.source] || j.source)}</dd>
          <dt>Amounts</dt><dd>${safe({ exclusive: "Tax exclusive", inclusive: "Tax inclusive", no_tax: "No tax" }[j.amountsAre])}</dd>
          <dt>Created</dt><dd>${safe(j.createdBy || "—")} · ${dateTime(j.createdAt)}</dd>
          ${j.postedAt ? `<dt>Posted</dt><dd>${safe(j.postedBy || "—")} · ${dateTime(j.postedAt)}</dd>` : ""}
          ${j.reverses ? `<dt>Reverses</dt><dd><a href="#/journals/${safe(j.reverses.id)}">${safe(j.reverses.number)}</a> · ${safe(j.reversalReason || "")}</dd>` : ""}
          ${j.reversedBy ? `<dt>Reversed by</dt><dd><a href="#/journals/${safe(j.reversedBy.id)}">${safe(j.reversedBy.number)}</a></dd>` : ""}
        </dl>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Account</th><th scope="col">Description</th><th scope="col">Tax</th><th scope="col" class="num">Debit</th><th scope="col" class="num">Credit</th></tr></thead><tbody>
          ${lines.map(l => `<tr class="${l.isTaxLine ? "taxline" : ""}"><td><span class="mono">${safe(l.accountCode)}</span> ${safe(l.accountName)}</td>
            <td>${safe(l.description)}</td><td>${safe(l.taxCode || "")}</td>
            <td class="num mono">${money(l.debit, { blankZero: true })}</td><td class="num mono">${money(l.credit, { blankZero: true })}</td></tr>`).join("")}
        </tbody><tfoot><tr><th colspan="3" scope="row">Total</th><td class="num mono"><strong>${money(j.totalDebit)}</strong></td><td class="num mono"><strong>${money(j.totalCredit)}</strong></td></tr></tfoot></table></div>
        ${j.status === "draft" && j.totalDebit !== j.totalCredit ? `<p class="balance bad">Out of balance by ${money(Math.abs(j.totalDebit - j.totalCredit))}. It can't be posted until it balances.</p>` : ""}
        <div class="actions">
          ${can.edit ? `<a class="btn" href="#/journals/${safe(j.id)}/edit">Edit</a>` : ""}
          ${can.post ? '<button class="btn primary" type="button" data-post>Post</button>' : ""}
          ${can.delete ? '<button class="btn danger" type="button" data-delete>Delete draft</button>' : ""}
          ${can.reverse ? '<button class="btn" type="button" data-reverse>Reverse</button>' : ""}
        </div>
      </section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if ("post" in b.dataset) {
        b.disabled = true;
        const r = await call("journal_post", { id });
        await load();
        flash(view, `Posted as ${r.number}.`, "good");
      } else if ("delete" in b.dataset) {
        if (!window.confirm("Delete this draft journal? Drafts aren't part of the ledger, so nothing is lost from the books.")) return;
        await call("journal_delete", { id });
        location.hash = "#/journals";
      } else if ("reverse" in b.dataset) {
        const reason = window.prompt("Reverse this journal? A mirror-image journal is posted and this one is marked reversed. Reason:", "");
        if (reason === null) return;
        const when = window.prompt("Date for the reversal (YYYY-MM-DD). Leave as is to use the original date:", "");
        if (when === null) return;
        b.disabled = true;
        const r = await call("journal_reverse", { id, reason, date: when.trim() || null });
        location.hash = `#/journals/${r.id}`;
      }
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}
