// Chart of accounts: grouped by type, balances as at today, add / edit /
// archive for people with ledger.manage.
import { call, chip, clearErrors, date, fieldError, flash, friendlyError, money, options, safe, TYPE_LABEL, TYPE_ORDER } from "../lib/ui.js";

const SUBTYPES = {
  asset: [["general", "General"], ["bank", "Bank"], ["inventory", "Inventory"], ["current_asset", "Current asset"], ["fixed_asset", "Fixed asset"], ["accumulated_depreciation", "Accumulated depreciation"]],
  liability: [["general", "General"], ["current_liability", "Current liability"], ["non_current_liability", "Non-current liability"], ["payg", "PAYG withholding"], ["super", "Superannuation"], ["payroll", "Payroll"]],
  equity: [["general", "General"], ["share_capital", "Share capital"]],
  revenue: [["general", "General"]], cost_of_sales: [["general", "General"]], expense: [["general", "General"]], other_income: [["general", "General"]], other_expense: [["general", "General"]]
};

export async function renderChart(view) {
  let d = await call("ledger_setup");
  let query = "", showArchived = false, editing = null;
  const taxName = id => d.taxCodes.find(t => t.id === id)?.code || "";

  const form = a => {
    const type = a?.type || "expense";
    const subtypes = SUBTYPES[type].some(s => s[0] === a?.subtype) ? SUBTYPES[type] : [...SUBTYPES[type], [a?.subtype, a?.subtype]].filter(s => s[0]);
    return `<form class="panel" data-acc-form>
      <h2>${a?.id ? `Edit ${safe(a.code)} ${safe(a.name)}` : "Add an account"}</h2>
      ${a?.isSystem ? '<p class="note small">System account: used by the posting rules, so its type is fixed and it cannot be archived.</p>' : ""}
      <div class="grid4">
        <div class="fld"><label for="ac-code">Code</label><input id="ac-code" value="${safe(a?.code || "")}" maxlength="12" required><small class="err" data-err="ac-code"></small></div>
        <div class="fld wide"><label for="ac-name">Name</label><input id="ac-name" value="${safe(a?.name || "")}" maxlength="120" required><small class="err" data-err="ac-name"></small></div>
        <div class="fld"><label for="ac-type">Type</label><select id="ac-type" ${a?.isSystem ? "disabled" : ""}>${options(TYPE_ORDER.map(t => [t, TYPE_LABEL[t]]), type)}</select></div>
        <div class="fld"><label for="ac-sub">Kind</label><select id="ac-sub" ${a?.isSystem ? "disabled" : ""}>${options(subtypes, a?.subtype || "general")}</select></div>
      </div>
      <div class="grid3">
        <div class="fld"><label for="ac-tax">Default tax code</label><select id="ac-tax">${options([["", "None"], ...d.taxCodes.filter(t => t.active).map(t => [t.id, `${t.code} · ${t.name}`])], a?.defaultTaxCodeId || "")}</select></div>
        <div class="fld wide"><label for="ac-desc">Description</label><input id="ac-desc" value="${safe(a?.description || "")}" maxlength="500"></div>
      </div>
      <label class="check"><input type="checkbox" id="ac-manual" ${a?.allowManual === false ? "" : "checked"} ${a?.isSystem ? "disabled" : ""}> Allow manual journals to this account</label>
      <div class="actions"><button class="btn primary" type="submit">${a?.id ? "Save changes" : "Add account"}</button><button class="btn" type="button" data-cancel>Cancel</button></div>
    </form>`;
  };

  const draw = () => {
    const q = query.toLowerCase();
    const list = d.accounts.filter(a => (showArchived || a.status === "active") && (!q || `${a.code} ${a.name}`.toLowerCase().includes(q)));
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING</p><h1>Chart of accounts</h1>
        <p class="muted">Balances as at ${date(d.asAt)}: balance sheet accounts to date, profit and loss accounts for this financial year. Have Panalo's accountant review the chart before the first BAS.</p></div>
        ${d.can.manage ? '<button class="btn primary" type="button" data-add>Add account</button>' : ""}</header>
      ${editing !== null ? form(editing) : ""}
      <section class="panel">
        <div class="toolbar"><div class="fld"><label for="c-q">Find an account</label><input id="c-q" type="search" value="${safe(query)}" placeholder="Code or name"></div>
          <label class="check"><input type="checkbox" data-archived ${showArchived ? "checked" : ""}> Show archived</label></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Default tax</th><th scope="col" class="num">Balance</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        ${TYPE_ORDER.map(t => {
          const rows = list.filter(a => a.type === t);
          if (!rows.length) return "";
          return `<tbody><tr class="group"><th colspan="5" scope="colgroup">${safe(TYPE_LABEL[t])}</th></tr>${rows.map(a => {
            const shown = ["asset", "expense", "cost_of_sales", "other_expense"].includes(a.type) ? a.balance : -a.balance;
            return `<tr class="${a.status === "archived" ? "inactive" : ""}"><td class="mono">${safe(a.code)}</td>
              <td><a href="#/reports?type=account&account=${safe(a.id)}">${safe(a.name)}</a>${a.isSystem ? ` ${chip("System", "info")}` : ""}${a.allowManual ? "" : ` ${chip("Module entries only", "")}`}${a.status === "archived" ? ` ${chip("Archived", "")}` : ""}
                ${a.description ? `<small>${safe(a.description)}</small>` : ""}</td>
              <td>${safe(taxName(a.defaultTaxCodeId))}</td><td class="num mono">${money(shown, { blankZero: true })}</td>
              <td class="row-acts">${d.can.manage ? `<button type="button" class="link" data-edit="${safe(a.id)}">Edit</button>
                ${a.isSystem ? "" : `<button type="button" class="link" data-status="${safe(a.id)}" data-active="${a.status === "archived"}">${a.status === "archived" ? "Restore" : "Archive"}</button>`}` : ""}</td></tr>`;
          }).join("")}</tbody>`;
        }).join("")}
        </table></div>
      </section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    view.querySelector("#c-q").addEventListener("input", e => { query = e.target.value; const p = e.target.selectionStart; draw(); const b = view.querySelector("#c-q"); b.focus(); b.setSelectionRange(p, p); });
    view.querySelector("#ac-type")?.addEventListener("change", e => {
      view.querySelector("#ac-sub").innerHTML = options(SUBTYPES[e.target.value], "general");
    });
  };
  draw();

  view.addEventListener("change", e => { if (e.target.matches("[data-archived]")) { showArchived = e.target.checked; draw(); } });
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if ("add" in b.dataset) { editing = {}; draw(); view.querySelector("#ac-code").focus(); return; }
    if ("cancel" in b.dataset) { editing = null; draw(); return; }
    if (b.dataset.edit) { editing = d.accounts.find(a => a.id === b.dataset.edit); draw(); view.querySelector("#ac-name").focus(); return; }
    if (b.dataset.status) {
      try {
        await call("account_set_status", { id: b.dataset.status, active: b.dataset.active === "true" });
        d = await call("ledger_setup");
        draw();
        flash(view, "Saved.", "good");
      } catch (error) { flash(view, friendlyError(error), "bad"); }
    }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-acc-form]")) return;
    e.preventDefault();
    clearErrors(view);
    const v = id => view.querySelector(`#${id}`).value.trim();
    if (!/^[0-9A-Za-z][0-9A-Za-z.-]{0,11}$/.test(v("ac-code"))) return fieldError(view, "ac-code", "1 to 12 letters, digits, dots or dashes.");
    if (v("ac-name").length < 2) return fieldError(view, "ac-name", "Give the account a name.");
    try {
      await call("account_save", { id: editing?.id || null, code: v("ac-code"), name: v("ac-name"), type: v("ac-type"), subtype: v("ac-sub"),
        defaultTaxCodeId: v("ac-tax") || null, description: v("ac-desc"), allowManual: view.querySelector("#ac-manual").checked });
      d = await call("ledger_setup");
      editing = null;
      draw();
      flash(view, "Account saved.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
