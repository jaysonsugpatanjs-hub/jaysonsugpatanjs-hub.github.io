// Accounting periods: open, soft-locked (only people who can reopen periods
// may post) or closed (nobody posts). Reopening a closed period is logged.
import { call, chip, date, dateTime, flash, friendlyError, monthLabel, safe } from "../lib/ui.js";

const STATUS = { open: ["Open", "good"], soft_locked: ["Locked", "pending"], closed: ["Closed", "bad"] };

export async function renderPeriods(view) {
  let d = await call("periods_list");
  const draw = () => {
    const next = d.years.length ? new Date(Date.parse(d.years[0].end) + 86400000).toISOString().slice(0, 10) : d.today;
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ACCOUNTING</p><h1>Accounting periods</h1>
        <p class="muted">Lock a month once its figures are checked: only people who can reopen periods can then post into it. Close it after BAS or year-end; reopening a closed month needs a reason and is recorded.</p></div>
        ${d.can.manage ? `<button class="btn" type="button" data-add-year="${safe(next)}">Add the next financial year</button>` : ""}</header>
      ${d.years.map(y => `<section class="panel"><h2>${safe(y.name)} <span class="muted small">${date(y.start)} to ${date(y.end)}</span></h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Month</th><th scope="col">Dates</th><th scope="col">Status</th><th scope="col">Last changed</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${y.periods.map(p => {
          const [l, t] = STATUS[p.status];
          const current = d.today >= p.start && d.today <= p.end;
          const acts = [];
          if (p.status === "open" && d.can.post) acts.push(`<button class="link" type="button" data-set="${p.id}" data-to="soft_locked">Lock</button>`, `<button class="link" type="button" data-set="${p.id}" data-to="closed">Close</button>`);
          if (p.status === "soft_locked" && d.can.post) acts.push(`<button class="link" type="button" data-set="${p.id}" data-to="open">Unlock</button>`, `<button class="link" type="button" data-set="${p.id}" data-to="closed">Close</button>`);
          if (p.status === "closed" && d.can.reopen) acts.push(`<button class="link" type="button" data-set="${p.id}" data-to="open" data-reason>Reopen</button>`);
          return `<tr class="${current ? "current" : ""}"><td><strong>${safe(monthLabel(p.start))}</strong>${current ? ` ${chip("This month", "info")}` : ""}</td>
            <td class="muted">${date(p.start)} – ${date(p.end)}</td><td>${chip(l, t)}</td>
            <td class="muted small">${p.changedAt ? `${safe(p.changedBy || "")} · ${dateTime(p.changedAt)}` : "—"}</td><td class="row-acts">${acts.join(" ")}</td></tr>`;
        }).join("")}</tbody></table></div></section>`).join("")}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  draw();
  view.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.addYear) {
        await call("financial_year_add", { date: b.dataset.addYear });
      } else if (b.dataset.set) {
        let reason = null;
        if ("reason" in b.dataset) {
          reason = window.prompt("Reopen this closed month? Give the reason for the record:", "");
          if (reason === null) return;
        } else if (b.dataset.to === "closed" && !window.confirm("Close this month? Nobody can post into it until someone with permission reopens it.")) return;
        b.disabled = true;
        await call("period_set_status", { id: b.dataset.set, status: b.dataset.to, reason });
      } else return;
      d = await call("periods_list");
      draw();
      flash(view, "Saved.", "good");
    } catch (error) {
      b.disabled = false;
      flash(view, friendlyError(error), "bad");
    }
  });
}
