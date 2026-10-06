// Audit log viewer: who did what, when, with old and new values.
import { call, dateTime, flash, friendlyError, options, safe } from "../lib/ui.js";

const ENTITIES = [["", "Everything"], ["company_settings", "Company settings"], ["company_bank_account", "Company bank accounts"], ["approval", "Approvals"],
  ["profile_role", "Roles"], ["number_sequence", "Numbering"], ["audit_log", "Audit log views"]];

const short = v => {
  if (v === null || v === undefined) return "";
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

function changes(e) {
  const o = e.oldValue || {}, n = e.newValue || {};
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])];
  if (!keys.length) return e.details && Object.keys(e.details).length ? `<small class="muted">${safe(short(e.details))}</small>` : "";
  return `<ul class="diff">${keys.map(k => `<li><span class="k">${safe(k)}</span> ${o[k] !== undefined ? `<del>${safe(short(o[k]))}</del> → ` : ""}<ins>${safe(short(n[k]))}</ins></li>`).join("")}</ul>`;
}

export async function renderAudit(view) {
  const f = { entityType: "", event: "", from: "", to: "", page: 1 };
  const load = async () => {
    const d = await call("audit_list", f);
    const pages = d.total ? Math.max(1, Math.ceil(d.total / d.pageSize)) : null;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ADMINISTRATION</p><h1>Audit log</h1>
        <p class="muted">Every change across the portal and Panalo Accounts. Records can't be edited or deleted, by anyone.</p></div></header>
      <section class="panel">
        <form class="toolbar" data-filter>
          <div class="fld"><label for="a-ent">Area</label><select id="a-ent">${options(ENTITIES, f.entityType)}</select></div>
          <div class="fld"><label for="a-ev">Event contains</label><input id="a-ev" value="${safe(f.event)}" placeholder="e.g. approved"></div>
          <div class="fld"><label for="a-from">From</label><input id="a-from" type="date" value="${safe(f.from)}"></div>
          <div class="fld"><label for="a-to">To</label><input id="a-to" type="date" value="${safe(f.to)}"></div>
          <button class="btn" type="submit">Filter</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Event</th><th scope="col">Record</th><th scope="col">Change</th></tr></thead><tbody>
          ${d.events.map(e => `<tr><td class="nowrap">${dateTime(e.at)}</td><td>${safe(e.actor)}${e.subject ? `<small>about ${safe(e.subject)}</small>` : ""}</td>
            <td><code>${safe(e.event)}</code></td><td>${safe(e.entityType || "")}${e.entityId ? `<small class="mono">${safe(String(e.entityId).slice(0, 8))}</small>` : ""}</td><td>${changes(e)}</td></tr>`).join("")
            || '<tr><td colspan="5" class="muted">No events match.</td></tr>'}
        </tbody></table></div>
        <div class="pager"><button type="button" class="btn" data-page="-1" ${f.page <= 1 ? "disabled" : ""}>Newer</button>
          <span class="muted small">Page ${f.page}${pages ? ` of ${pages}` : ""}</span>
          <button type="button" class="btn" data-page="1" ${pages && f.page >= pages ? "disabled" : ""}>Older</button></div>
        <p class="msg" data-msg role="status" aria-live="polite"></p>
      </section>`;
  };
  await load();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-filter]")) return;
    e.preventDefault();
    Object.assign(f, { entityType: view.querySelector("#a-ent").value, event: view.querySelector("#a-ev").value.trim(), from: view.querySelector("#a-from").value, to: view.querySelector("#a-to").value, page: 1 });
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    const b = e.target.closest("[data-page]");
    if (!b) return;
    f.page = Math.max(1, f.page + Number(b.dataset.page));
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
