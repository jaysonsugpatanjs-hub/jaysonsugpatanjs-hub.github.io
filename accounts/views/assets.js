// Fixed assets: the register, an asset's details with its depreciation,
// documents and disposal; monthly depreciation runs; categories; and the
// reconciliation of the register to the ledger. Accounting depreciation is
// posted; the tax treatment is recorded for the accountant only.
// Routes: #/assets, #/assets/new, #/assets/new?line=<billLineId>, #/assets/<id>, #/assets/<id>/edit.
import { call, chip, date, dateTime, downloadCsv, endOfMonth, field, flash, friendlyError, hashParams, money, options, safe, today } from "../lib/ui.js";
import { attachmentsPanel, wireAttachments } from "../lib/docs.js";

const METHOD = { straight_line: "Straight line", diminishing_value: "Diminishing value", none: "Not depreciated" };
const TAX_METHOD = [["", "Not recorded"], ["prime_cost", "Prime cost"], ["diminishing_value", "Diminishing value"], ["instant_write_off", "Instant asset write-off"],
  ["small_business_pool", "Small business pool"], ["not_depreciable", "Not depreciable"]];
const TABS = [["register", "Register"], ["depreciation", "Depreciation"], ["categories", "Categories"], ["reconciliation", "Reconciliation"]];
const life = m => (m ? (m % 12 ? `${m} months` : `${m / 12} years`) : "—");

export async function renderAssets(view, ctx) {
  const [id, mode] = (ctx.sub || "").split("?")[0].split("/");
  if (id === "new") return assetForm(view, ctx, null);
  if (id && mode === "edit") return assetForm(view, ctx, id);
  if (id) return assetView(view, ctx, id);
  return overview(view, ctx);
}

/* ---------------- Register, depreciation, categories, reconciliation ---------------- */

async function overview(view, ctx) {
  const st = { tab: hashParams().get("tab") || "register", show: "active", q: "" };
  let d, preview = null, rec = null, bills = null;
  const catName = new Map();
  const draw = () => {
    const rows = d.assets.filter(a => (st.show === "all" || a.status === st.show) && (!st.q || `${a.number} ${a.name} ${a.serial || ""} ${a.location || ""}`.toLowerCase().includes(st.q)));
    const tot = rows.reduce((t, a) => ({ cost: t.cost + a.cost, acc: t.acc + (a.status === "active" ? a.accumulated : 0), book: t.book + a.bookValue }), { cost: 0, acc: 0, book: 0 });
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING</p><h1>Fixed assets</h1>
        <p class="muted">Tools, vehicles, plant and office equipment, with depreciation posted to the ledger each month. Book values are at ${date(d.asAt)}.
          Tax depreciation is recorded for your accountant; it isn't posted or claimed here.</p></div>
        ${d.can.manage ? '<div class="actions"><a class="btn primary" href="#/assets/new">Add an asset</a></div>' : ""}</header>
      <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === st.tab}" class="${k === st.tab ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
      ${st.tab === "register" ? `
        ${bills && bills.length ? `<section class="panel"><h2>Bill lines on fixed asset accounts, not in the register yet</h2><div class="tbl-wrap"><table class="tbl compact"><tbody>
          ${bills.map(l => `<tr><td class="mono">${safe(l.bill)}</td><td>${date(l.date)}</td><td>${safe(l.supplier || "")}</td><td>${safe(l.description)}</td><td>${safe(l.account)}</td>
            <td class="num mono">${money(l.cost)}</td><td><a class="btn" href="#/assets/new?line=${safe(l.lineId)}">Add to register</a></td></tr>`).join("")}
        </tbody></table></div></section>` : ""}
        <form class="panel toolbar" data-filter>
          <div class="fld"><label for="af-q">Search</label><input id="af-q" type="search" value="${safe(st.q)}" placeholder="Number, name, serial, location"></div>
          <div class="fld"><label for="af-s">Show</label><select id="af-s">${options([["active", "In use"], ["disposed", "Disposed"], ["all", "All"]], st.show)}</select></div>
          <button type="button" class="btn" data-csv>Download CSV</button></form>
        <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Asset</th><th scope="col">Category</th><th scope="col">In service</th><th scope="col">Location</th>
          <th scope="col" class="num">Cost</th><th scope="col" class="num">Depreciation</th><th scope="col" class="num">Book value</th><th scope="col">Status</th></tr></thead><tbody>
          ${rows.map(a => `<tr><td><a href="#/assets/${safe(a.id)}"><strong>${safe(a.name)}</strong></a><small class="mono">${safe(a.number)}${a.serial ? ` · ${safe(a.serial)}` : ""}</small></td>
            <td>${safe(catName.get(a.categoryId) || "")}</td><td class="nowrap">${date(a.inService)}</td><td>${safe(a.location || "")}${a.custodian ? `<small>${safe(a.custodian)}</small>` : ""}</td>
            <td class="num mono">${money(a.cost)}</td><td class="num mono">${a.status === "active" ? money(a.accumulated) : "—"}</td><td class="num mono">${money(a.bookValue)}</td>
            <td>${a.status === "active" ? chip("In use", "good") : chip(`Disposed ${date(a.disposalDate)}`, "")}</td></tr>`).join("")
            || `<tr><td colspan="8" class="muted">${d.assets.length ? "Nothing matches." : "No assets yet."}</td></tr>`}
          </tbody>${rows.length ? `<tfoot><tr><th scope="row" colspan="4">Total</th><td class="num mono">${money(tot.cost)}</td><td class="num mono">${money(tot.acc)}</td><td class="num mono">${money(tot.book)}</td><td></td></tr></tfoot>` : ""}
        </table></div></section>` : ""}
      ${st.tab === "depreciation" ? `
        ${d.can.manage ? `<form class="panel toolbar" data-preview>
          ${field({ id: "dp-to", label: "Depreciate to month end", type: "date", value: preview?.periodEnd || d.nextRun })}
          <button class="btn" type="submit">Preview</button>
          ${preview ? `<button type="button" class="btn primary" data-run ${preview.rows.length ? "" : "disabled"}>Post ${money(preview.total)} to ${date(preview.periodEnd)}</button>` : ""}
          <p class="muted small">Runs go month by month${d.lastRun ? `; the last was to ${date(d.lastRun)}` : ""}. One journal a run, by category. Only the latest run can be undone.</p></form>` : ""}
        ${preview ? `<section class="panel"><h2>Preview to ${date(preview.periodEnd)}</h2><table class="tbl compact"><thead><tr><th scope="col">Asset</th><th scope="col">From</th><th scope="col" class="num">Depreciation</th></tr></thead><tbody>
          ${preview.rows.map(r => `<tr><td><span class="mono">${safe(r.number)}</span> ${safe(r.name)}</td><td>${date(r.from)}</td><td class="num mono">${money(r.amount)}</td></tr>`).join("")
            || '<tr><td colspan="3" class="muted">Nothing to depreciate for this period.</td></tr>'}</tbody></table></section>` : ""}
        <section class="panel"><h2>Runs</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">To</th><th scope="col" class="num">Total</th><th scope="col">Journal</th><th scope="col">Run by</th><th scope="col">Status</th><th scope="col"></th></tr></thead><tbody>
          ${d.runs.map((r, i) => `<tr><td class="nowrap">${date(r.periodEnd)}</td><td class="num mono">${money(r.total)}</td>
            <td>${r.journalId ? `<a class="mono" href="#/journals/${safe(r.journalId)}">${safe(r.journal)}</a>` : "—"}</td><td>${safe(r.by || "")}<small>${dateTime(r.at)}</small></td>
            <td>${r.status === "posted" ? chip("Posted", "good") : chip("Undone", "")}</td>
            <td>${d.can.manage && r.status === "posted" && i === d.runs.findIndex(x => x.status === "posted") ? `<button type="button" class="link" data-undo="${safe(r.id)}">Undo</button>` : ""}</td></tr>`).join("")
            || '<tr><td colspan="6" class="muted">No depreciation runs yet.</td></tr>'}
        </tbody></table></div></section>` : ""}
      ${st.tab === "categories" ? `<section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Category</th><th scope="col">Cost account</th><th scope="col">Accumulated depreciation</th>
        <th scope="col">Expense</th><th scope="col">Method</th><th scope="col">Useful life</th><th scope="col">Tax effective life</th><th scope="col"></th></tr></thead><tbody>
        ${d.categories.map(c => `<tr><td><strong>${safe(c.name)}</strong>${c.active ? "" : " <small>Not in use</small>"}</td><td>${acct(c.assetAccountId)}</td><td>${acct(c.accumulatedAccountId)}</td><td>${acct(c.expenseAccountId)}</td>
          <td>${safe(METHOD[c.method])}</td><td>${life(c.lifeMonths)}</td><td>${c.taxLife ? `${c.taxLife} years` : "—"}</td>
          <td>${d.can.manage ? `<button type="button" class="link" data-cat="${safe(c.id)}">Edit</button>` : ""}</td></tr>`).join("")}
        </tbody></table></div>
        ${d.can.manage ? '<div class="actions"><button type="button" class="btn" data-cat="">Add a category</button></div>' : ""}
        <p class="muted small">Useful life is your accounting estimate. The tax effective life is a note for the accountant (the ATO publishes effective lives); it doesn't change what's posted.</p></section>
        <div data-cat-form></div>` : ""}
      ${st.tab === "reconciliation" ? `<form class="panel toolbar" data-rec>${field({ id: "rc-d", label: "As at", type: "date", value: rec?.asAt || d.asAt })}<button class="btn" type="submit">Check</button></form>
        ${rec ? `<section class="panel"><h2>Register to ledger at ${date(rec.asAt)}</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Category</th>
          <th scope="col" class="num">Register cost</th><th scope="col" class="num">Ledger cost</th><th scope="col" class="num">Register depreciation</th><th scope="col" class="num">Ledger depreciation</th><th scope="col">Check</th></tr></thead><tbody>
          ${rec.rows.map(r => { const okRow = Math.abs(r.registerCost - r.ledgerCost) < 0.005 && Math.abs(r.registerAccumulated - r.ledgerAccumulated) < 0.005;
            return `<tr><td><strong>${safe(r.category)}</strong><small>${safe(r.assetAccount)} · ${safe(r.accumulatedAccount)}</small></td><td class="num mono">${money(r.registerCost)}</td><td class="num mono">${money(r.ledgerCost)}</td>
              <td class="num mono">${money(r.registerAccumulated)}</td><td class="num mono">${money(r.ledgerAccumulated)}</td><td>${okRow ? chip("Agrees", "good") : chip("Differs", "bad")}</td></tr>`; }).join("")}
          </tbody></table></div>
          <p class="muted small">A difference usually means a bill or journal posted to a fixed asset account that isn't in the register yet, an asset entered with a cost that differs from the bill,
            or opening balances not brought in. Categories that share accounts show the shared ledger balance on each.</p></section>` : ""}` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const acctName = new Map();
  const acct = idv => safe(acctName.get(idv) || "—");
  const load = async () => {
    d = await call("assets_list");
    d.categories.forEach(c => catName.set(c.id, c.name));
    (d.options?.accounts || []).forEach(a => acctName.set(a.id, `${a.code} ${a.name}`));
    if (d.can.manage && bills === null) bills = (await call("asset_from_bills")).lines;
    draw();
  };
  await load();
  if (st.tab === "reconciliation") { rec = await call("asset_reconciliation", { asAt: d.asAt }); draw(); }

  const catForm = c => {
    const opts = d.options.accounts;
    const pick = (sel, list) => `<option value="">Account…</option>${list.map(a => `<option value="${safe(a.id)}" ${a.id === sel ? "selected" : ""}>${safe(a.code)} ${safe(a.name)}</option>`).join("")}`;
    return `<form class="panel" data-cat-save data-id="${safe(c?.id || "")}"><h2>${c ? `Edit ${safe(c.name)}` : "New category"}</h2><div class="grid3">
      ${field({ id: "ct-n", label: "Name", value: c?.name || "", required: true, attrs: 'maxlength="80"' })}
      <div class="fld"><label for="ct-a">Cost account</label><select id="ct-a">${pick(c?.assetAccountId, opts.filter(a => a.subtype === "fixed_asset"))}</select></div>
      <div class="fld"><label for="ct-d">Accumulated depreciation account</label><select id="ct-d">${pick(c?.accumulatedAccountId, opts.filter(a => a.subtype === "accumulated_depreciation"))}</select></div>
      <div class="fld"><label for="ct-e">Depreciation expense account</label><select id="ct-e">${pick(c?.expenseAccountId, opts.filter(a => ["expense", "other_expense", "cost_of_sales"].includes(a.type)))}</select></div>
      <div class="fld"><label for="ct-m">Method</label><select id="ct-m">${options(Object.entries(METHOD), c?.method || "straight_line")}</select></div>
      ${field({ id: "ct-l", label: "Useful life (months)", type: "number", value: c?.lifeMonths ?? "", attrs: 'min="1" max="1200"' })}
      ${field({ id: "ct-t", label: "Tax effective life (years, a note)", type: "number", value: c?.taxLife ?? "", attrs: 'min="0" step="0.01"' })}
      ${c ? `<div class="fld"><label for="ct-act">In use</label><select id="ct-act">${options([["true", "Yes"], ["false", "No"]], String(c.active))}</select></div>` : ""}
      </div><div class="actions"><button class="btn primary" type="submit">Save</button><button type="button" class="btn" data-cat-cancel>Cancel</button></div></form>`;
  };

  view.addEventListener("input", e => { if (e.target.id === "af-q") { st.q = e.target.value.trim().toLowerCase(); const pos = e.target.selectionStart; draw(); const q = view.querySelector("#af-q"); q.focus(); q.setSelectionRange(pos, pos); } });
  view.addEventListener("change", e => { if (e.target.id === "af-s") { st.show = e.target.value; draw(); } });
  view.addEventListener("click", async e => {
    const tab = e.target.closest("[data-tab]"), undo = e.target.closest("[data-undo]"), cat = e.target.closest("[data-cat]");
    try {
      if (tab) {
        st.tab = tab.dataset.tab; preview = null;
        if (st.tab === "reconciliation" && !rec) rec = await call("asset_reconciliation", { asAt: d.asAt });
        draw();
      } else if (e.target.closest("[data-csv]")) {
        downloadCsv(`fixed-assets-${d.asAt}.csv`, [["Number", "Name", "Category", "Serial", "Location", "Custodian", "Purchased", "In service", "Method", "Useful life (months)", "Cost", "Accumulated depreciation", "Book value", "Status", "Disposed"],
          ...d.assets.map(a => [a.number, a.name, catName.get(a.categoryId) || "", a.serial || "", a.location || "", a.custodian || "", a.purchaseDate, a.inService, METHOD[a.method], a.lifeMonths ?? "",
            a.cost.toFixed(2), (a.status === "active" ? a.accumulated : 0).toFixed(2), a.bookValue.toFixed(2), a.status, a.disposalDate || ""])]);
      } else if (e.target.closest("[data-run]")) {
        if (!window.confirm(`Post depreciation of ${money(preview.total)} to ${date(preview.periodEnd)}?`)) return;
        await call("depreciation_run", { periodEnd: preview.periodEnd });
        preview = null; await load(); flash(view, "Depreciation posted.", "good");
      } else if (undo) {
        const reason = window.prompt("Undo this depreciation run? Its journal is reversed. Reason:", "");
        if (reason === null) return;
        await call("depreciation_undo", { id: undo.dataset.undo, reason });
        await load(); flash(view, "Run undone.", "good");
      } else if (cat) {
        view.querySelector("[data-cat-form]").innerHTML = catForm(d.categories.find(c => c.id === cat.dataset.cat));
        view.querySelector("#ct-n").focus();
      } else if (e.target.closest("[data-cat-cancel]")) view.querySelector("[data-cat-form]").innerHTML = "";
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`)?.value ?? "";
    try {
      if (e.target.matches("[data-filter]")) return;
      if (e.target.matches("[data-preview]")) {
        const to = v("dp-to");
        if (!to) return flash(view, "Choose the month end.", "bad");
        preview = await call("depreciation_preview", { periodEnd: endOfMonth(to) }); draw();
      } else if (e.target.matches("[data-rec]")) { rec = await call("asset_reconciliation", { asAt: v("rc-d") }); draw(); }
      else if (e.target.matches("[data-cat-save]")) {
        await call("asset_category_save", { id: e.target.dataset.id || null, name: v("ct-n"), assetAccountId: v("ct-a"), accumulatedAccountId: v("ct-d"), expenseAccountId: v("ct-e"),
          method: v("ct-m"), lifeMonths: v("ct-l"), taxLife: v("ct-t"), active: v("ct-act") !== "false" });
        await load(); flash(view, "Category saved.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- One asset ---------------- */

async function assetView(view, ctx, id) {
  let d, opts = null;
  const load = async () => {
    d = await call("asset_get", { id });
    const a = d.asset;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow"><a href="#/assets">FIXED ASSETS</a> · <span class="mono">${safe(a.number)}</span></p><h1>${safe(a.name)}</h1>
        <p>${a.status === "active" ? chip("In use", "good") : chip(`Disposed ${date(a.disposalDate)}`, "")} <span class="muted">${safe(a.category)}</span></p></div>
        ${d.can.edit ? `<div class="actions"><a class="btn" href="#/assets/${safe(id)}/edit">Edit</a><button type="button" class="btn" data-dispose>Sell or write off</button></div>` : ""}</header>
      <section class="panel"><div class="asset-sum">
        <div><span class="muted small">Cost (before GST)</span><strong class="mono">${money(a.cost)}</strong></div>
        <div><span class="muted small">Accumulated depreciation</span><strong class="mono">${money(a.accumulated)}</strong></div>
        <div><span class="muted small">Book value</span><strong class="mono">${money(a.bookValue)}</strong></div></div></section>
      <section class="panel"><h2>Details</h2><dl class="facts">
        <dt>Purchased</dt><dd>${date(a.purchaseDate)}${a.supplier ? ` from ${safe(a.supplier)}` : ""}${a.bill ? ` · bill <span class="mono">${safe(a.bill)}</span>` : ""}</dd>
        <dt>In service</dt><dd>${date(a.inService)}</dd>
        <dt>GST paid</dt><dd class="mono">${money(a.gst)}</dd>
        ${a.serial ? `<dt>Serial or rego</dt><dd class="mono">${safe(a.serial)}</dd>` : ""}
        ${a.location ? `<dt>Location</dt><dd>${safe(a.location)}</dd>` : ""}
        ${a.custodian ? `<dt>Looked after by</dt><dd>${safe(a.custodian)}</dd>` : ""}
        ${a.project ? `<dt>Project</dt><dd>${safe(a.project)}</dd>` : ""}
        ${a.description ? `<dt>Notes</dt><dd>${safe(a.description)}</dd>` : ""}</dl></section>
      <section class="panel"><h2>Accounting depreciation</h2><dl class="facts">
        <dt>Method</dt><dd>${safe(METHOD[a.method])}</dd><dt>Useful life</dt><dd>${life(a.lifeMonths)}</dd><dt>Residual value</dt><dd class="mono">${money(a.residual)}</dd>
        ${a.openingAccumulated ? `<dt>Opening depreciation</dt><dd class="mono">${money(a.openingAccumulated)} at ${date(a.openingDate)}</dd>` : ""}</dl>
        ${d.depreciation.length ? `<table class="tbl compact"><thead><tr><th scope="col">Period</th><th scope="col" class="num">Amount</th><th scope="col">Journal</th></tr></thead><tbody>
          ${d.depreciation.map(x => `<tr><td>${date(x.from)} – ${date(x.to)}${x.disposal ? " <small>to disposal</small>" : ""}</td><td class="num mono">${money(x.amount)}</td>
            <td>${x.journalId ? `<a class="mono" href="#/journals/${safe(x.journalId)}">${safe(x.journal)}</a>` : "—"}</td></tr>`).join("")}</tbody></table>`
          : '<p class="muted small">Not depreciated yet. Depreciation is posted by the monthly run (Fixed assets, Depreciation).</p>'}</section>
      <section class="panel"><h2>Tax treatment (for the accountant)</h2><dl class="facts">
        <dt>Method</dt><dd>${safe((TAX_METHOD.find(t => t[0] === (a.taxMethod || "")) || TAX_METHOD[0])[1])}</dd>
        <dt>Effective life</dt><dd>${a.taxLife ? `${a.taxLife} years` : "—"}</dd>${a.taxNotes ? `<dt>Notes</dt><dd>${safe(a.taxNotes)}</dd>` : ""}</dl>
        <p class="muted small">Recorded only: tax depreciation, write-offs and pooling are worked out by your accountant and aren't posted here.</p></section>
      ${a.status === "disposed" ? `<section class="panel"><h2>Disposal</h2><dl class="facts">
        <dt>Date</dt><dd>${date(a.disposalDate)}</dd><dt>Reason</dt><dd>${safe(a.disposalReason || "")}</dd>
        <dt>Proceeds (before GST)</dt><dd class="mono">${money(a.proceeds)}</dd><dt>GST on the sale</dt><dd class="mono">${money(a.disposalGst)}</dd>
        ${a.disposalJournal ? `<dt>Journal</dt><dd><a class="mono" href="#/journals/${safe(a.disposalJournal.id)}">${safe(a.disposalJournal.number)}</a></dd>` : ""}</dl></section>` : ""}
      <div data-dispose-form></div>
      ${attachmentsPanel(d.attachments, ctx.can("assets.manage"), "asset", id)}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  await load();
  wireAttachments(view, load);
  view.addEventListener("click", async e => {
    try {
      if (e.target.closest("[data-dispose]")) {
        opts = opts || (await call("assets_list")).options;
        const gst = opts.taxCodes.find(t => t.code === "GST");
        const into = opts.accounts.filter(a => ["asset", "liability"].includes(a.type) && a.allowManual && !["receivable", "payable", "gst", "fixed_asset", "accumulated_depreciation"].includes(a.subtype));
        view.querySelector("[data-dispose-form]").innerHTML = `<form class="panel" data-dispose-save><h2>Sell or write off</h2>
          <p class="muted small">Depreciation is worked out to the disposal date and posted with the disposal. The cost and its depreciation come off the register; the book value goes to
            7810 Book Value of Assets Disposed and the proceeds to 4950 Proceeds from Sale of Assets. A taxable sale's GST goes to the BAS.</p><div class="grid3">
          ${field({ id: "ds-d", label: "Date", type: "date", value: today(), required: true })}
          ${field({ id: "ds-p", label: "Proceeds before GST (0 if written off)", value: "0", attrs: 'inputmode="decimal"' })}
          <div class="fld"><label for="ds-t">Tax code on the sale</label><select id="ds-t">${options(opts.taxCodes.map(t => [t.id, `${t.code} · ${t.name}`]), gst?.id)}</select></div>
          <div class="fld"><label for="ds-i">Proceeds received into</label><select id="ds-i"><option value="">Choose…</option>${options(into.map(a => [a.id, `${a.code} ${a.name}`]))}</select>
            <small>A bank account, or a clearing account if you're invoicing the buyer.</small></div>
          ${field({ id: "ds-r", label: "Reason", required: true, attrs: 'maxlength="300" placeholder="Sold, traded in, scrapped, stolen"' })}
          </div><div class="actions"><button class="btn primary" type="submit">Post disposal</button><button type="button" class="btn" data-dispose-cancel>Cancel</button></div></form>`;
        view.querySelector("#ds-d").focus();
      } else if (e.target.closest("[data-dispose-cancel]")) view.querySelector("[data-dispose-form]").innerHTML = "";
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-dispose-save]")) return;
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value;
    try {
      if (!window.confirm("Post this disposal? It can't be undone from here: a correcting journal would be needed.")) return;
      await call("asset_dispose", { id, date: v("ds-d"), proceeds: v("ds-p"), taxCodeId: v("ds-t"), receivedInto: v("ds-i"), reason: v("ds-r") });
      await load(); flash(view, "Disposal posted.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Add or edit ---------------- */

async function assetForm(view, ctx, id) {
  const list = await call("assets_list");
  const o = list.options;
  if (!o) { view.innerHTML = '<section class="panel"><p>Your access doesn’t include changing fixed assets.</p></section>'; return; }
  const got = id ? await call("asset_get", { id }) : null;
  let a = got?.asset || null;
  const locked = !!got?.can.locked;
  if (got && !got.can.edit) { view.innerHTML = '<section class="panel"><p>A disposed asset can\u2019t be changed.</p></section>'; return; }
  const lineId = hashParams().get("line");
  if (!a && lineId) {
    const l = (await call("asset_from_bills")).lines.find(x => x.lineId === lineId);
    const cat = l && list.categories.find(c => c.assetAccountId === l.accountId && c.active);
    if (l) a = { name: l.description, purchaseDate: l.date, cost: l.cost, gst: l.gst, supplierId: l.supplierId, billId: l.billId, projectId: l.projectId, categoryId: cat?.id };
  }
  const cats = list.categories.filter(c => c.active || c.id === a?.categoryId);
  const dis = locked ? "disabled" : "";
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow"><a href="#/assets">FIXED ASSETS</a></p><h1>${id ? `Edit ${safe(a.number)}` : "Add an asset"}</h1>
      <p class="muted">Adding an asset doesn't post its cost: the purchase reaches the ledger through its bill (or a journal for opening balances). Depreciation and disposals post from here.</p>
      ${a?.billId && !id ? '<p class="muted">From a bill line: check the details, then save.</p>' : ""}
      ${locked ? '<p class="muted">This asset has been depreciated, so its cost, category, in-service date and opening depreciation are fixed. Undo the depreciation runs to change them.</p>' : ""}</div></header>
    <form class="panel" data-asset novalidate>
      <h2>The asset</h2><div class="grid3">
        ${field({ id: "as-n", label: "Name", value: a?.name || "", required: true, attrs: 'maxlength="160"' })}
        <div class="fld"><label for="as-c">Category</label><select id="as-c" ${dis}><option value="">Choose…</option>${options(cats.map(c => [c.id, c.name]), a?.categoryId)}</select><small class="err" data-err="as-c"></small></div>
        ${field({ id: "as-s", label: "Serial or registration", value: a?.serial || "", attrs: 'maxlength="80"' })}
        ${field({ id: "as-l", label: "Location", value: a?.location || "", attrs: 'maxlength="120"' })}
        <div class="fld"><label for="as-k">Looked after by</label><select id="as-k"><option value="">—</option>${options(o.staff.map(s => [s.id, s.name]), a?.custodianId)}</select></div>
        <div class="fld"><label for="as-j">Project</label><select id="as-j"><option value="">—</option>${options(o.projects.map(p => [p.id, p.label]), a?.projectId)}</select></div>
      </div>
      ${field({ id: "as-desc", label: "Notes", value: a?.description || "", wide: true, attrs: 'maxlength="2000"' })}
      <h2>Purchase</h2><div class="grid3">
        ${field({ id: "as-pd", label: "Purchase date", type: "date", value: a?.purchaseDate || today(), required: true })}
        ${field({ id: "as-is", label: "In service from", type: "date", value: a?.inService || "", hint: "Leave blank if the same as the purchase date", attrs: dis })}
        <div class="fld"><label for="as-sup">Supplier</label><select id="as-sup"><option value="">—</option>${options(o.suppliers.map(s => [s.id, s.name]), a?.supplierId)}</select></div>
        ${field({ id: "as-cost", label: "Cost before GST", value: a?.cost ?? "", required: true, attrs: `inputmode="decimal" ${dis}` })}
        ${field({ id: "as-gst", label: "GST paid", value: a?.gst ?? "", attrs: 'inputmode="decimal"', hint: "Claimed through the bill, not here" })}
      </div>
      <input type="hidden" id="as-bill" value="${safe(a?.billId || "")}">
      <h2>Accounting depreciation</h2><div class="grid3">
        <div class="fld"><label for="as-m">Method</label><select id="as-m"><option value="">Category default</option>${options(Object.entries(METHOD), id ? a.method : "")}</select></div>
        ${field({ id: "as-life", label: "Useful life (months)", type: "number", value: id ? a.lifeMonths ?? "" : "", hint: "Blank for the category default", attrs: 'min="1" max="1200"' })}
        ${field({ id: "as-res", label: "Residual value", value: a?.residual ?? "", attrs: 'inputmode="decimal"' })}
        ${field({ id: "as-oa", label: "Opening depreciation", value: a?.openingAccumulated || "", hint: "For an asset brought in from another system", attrs: `inputmode="decimal" ${dis}` })}
        ${field({ id: "as-od", label: "Opening depreciation at", type: "date", value: a?.openingDate || "", attrs: dis })}
      </div>
      <h2>Tax treatment (a note for the accountant)</h2><div class="grid3">
        <div class="fld"><label for="as-tm">Tax method</label><select id="as-tm">${options(TAX_METHOD, a?.taxMethod || "")}</select></div>
        ${field({ id: "as-tl", label: "Tax effective life (years)", type: "number", value: a?.taxLife ?? "", attrs: 'min="0" step="0.01"' })}
        ${field({ id: "as-tn", label: "Tax notes", value: a?.taxNotes || "", attrs: 'maxlength="1000"' })}
      </div>
      <div class="actions"><button class="btn primary" type="submit">Save</button><a class="btn" href="${id ? `#/assets/${safe(id)}` : "#/assets"}">Cancel</a></div>
    </form><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  view.querySelector("[data-asset]").addEventListener("submit", async e => {
    e.preventDefault();
    const v = x => view.querySelector(`#${x}`).value;
    try {
      const r = await call("asset_save", { id, name: v("as-n"), categoryId: locked ? a.categoryId : v("as-c"), serial: v("as-s"), location: v("as-l"), custodianId: v("as-k"), projectId: v("as-j"),
        description: v("as-desc"), purchaseDate: v("as-pd"), inService: locked ? a.inService : v("as-is"), supplierId: v("as-sup"), billId: v("as-bill"),
        cost: locked ? a.cost : v("as-cost"), gst: v("as-gst"), method: v("as-m"), lifeMonths: v("as-life"), residual: v("as-res"),
        openingAccumulated: locked ? a.openingAccumulated : v("as-oa"), openingDate: locked ? a.openingDate || "" : v("as-od"), taxMethod: v("as-tm"), taxLife: v("as-tl"), taxNotes: v("as-tn") });
      location.hash = `#/assets/${r.id}`;
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
