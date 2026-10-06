// GST tax codes, with the BAS labels each one feeds (used in Phase 7).
import { call, chip, flash, friendlyError, options, safe } from "../lib/ui.js";

const KINDS = [["gst_income", "GST on income"], ["gst_expense", "GST on expenses"], ["gst_capital", "GST on capital purchases"], ["gst_free_income", "GST-free income"],
  ["gst_free_expense", "GST-free expenses"], ["export", "Exports"], ["input_taxed_income", "Input-taxed sales"], ["input_taxed_expense", "Input-taxed purchases"],
  ["no_gst", "No GST (BAS excluded)"], ["out_of_scope", "Out of scope"]];

export async function renderTaxCodes(view) {
  let d = await call("ledger_setup");
  let editing = null;
  const draw = () => {
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING</p><h1>Tax codes</h1>
        <p class="muted">GST is worked out per line, to the cent, rounding half a cent up. The code, kind and rate of a code that has been used can't change, so past transactions keep their meaning; add a new code instead.</p></div>
        ${d.can.manage ? '<button class="btn primary" type="button" data-add>Add tax code</button>' : ""}</header>
      ${editing ? `<form class="panel" data-tax-form><h2>${editing.id ? `Edit ${safe(editing.code)}` : "Add a tax code"}</h2>
        <div class="grid4">
          <div class="fld"><label for="t-code">Code</label><input id="t-code" value="${safe(editing.code || "")}" maxlength="12" ${editing.isSystem ? "disabled" : ""}></div>
          <div class="fld wide"><label for="t-name">Name</label><input id="t-name" value="${safe(editing.name || "")}" maxlength="80"></div>
          <div class="fld"><label for="t-kind">Kind</label><select id="t-kind" ${editing.isSystem ? "disabled" : ""}>${options(KINDS, editing.kind || "gst_income")}</select></div>
          <div class="fld"><label for="t-rate">Rate %</label><input id="t-rate" type="number" min="0" max="99" step="0.01" value="${editing.rate != null ? Math.round(editing.rate * 10000) / 100 : 10}" ${editing.isSystem ? "disabled" : ""}></div>
        </div>
        <div class="grid3"><div class="fld"><label for="t-applies">Used for</label><select id="t-applies">${options([["sales", "Sales"], ["purchases", "Purchases"], ["both", "Both"]], editing.appliesTo || "both")}</select></div>
          <div class="fld wide"><label for="t-desc">Description</label><input id="t-desc" value="${safe(editing.description || "")}" maxlength="300"></div></div>
        <label class="check"><input type="checkbox" id="t-active" ${editing.active === false ? "" : "checked"}> Active</label>
        <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-cancel>Cancel</button></div></form>` : ""}
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col" class="num">Rate</th><th scope="col">Used for</th><th scope="col">BAS labels</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${d.taxCodes.map(t => `<tr class="${t.active ? "" : "inactive"}"><td class="mono"><strong>${safe(t.code)}</strong></td><td>${safe(t.name)}<small>${safe(t.description)}</small></td>
          <td class="num">${Math.round(t.rate * 10000) / 100}%</td><td>${safe({ sales: "Sales", purchases: "Purchases", both: "Both" }[t.appliesTo])}</td>
          <td class="mono">${safe((t.basLabels || []).join(", ") || "—")}</td><td>${t.active ? chip("Active", "good") : chip("Inactive", "")}</td>
          <td>${d.can.manage ? `<button type="button" class="link" data-edit="${safe(t.id)}">Edit</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div></section>
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  draw();
  view.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if ("add" in b.dataset) { editing = {}; draw(); }
    else if ("cancel" in b.dataset) { editing = null; draw(); }
    else if (b.dataset.edit) { editing = d.taxCodes.find(t => t.id === b.dataset.edit); draw(); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-tax-form]")) return;
    e.preventDefault();
    const v = id => view.querySelector(`#${id}`).value.trim();
    try {
      await call("tax_code_save", { id: editing.id || null, code: editing.isSystem ? editing.code : v("t-code"), name: v("t-name"),
        kind: editing.isSystem ? editing.kind : v("t-kind"), ratePercent: editing.isSystem ? editing.rate * 100 : Number(v("t-rate")),
        appliesTo: v("t-applies"), description: v("t-desc"), active: view.querySelector("#t-active").checked });
      d = await call("ledger_setup");
      editing = null;
      draw();
      flash(view, "Tax code saved.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
