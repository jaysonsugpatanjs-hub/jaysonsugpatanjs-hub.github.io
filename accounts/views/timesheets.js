// Timesheets. Routes:
//   #/timesheets[?week=YYYY-MM-DD&person=<id>]  a week (your own, or a crew member's for approvers)
//   #/timesheets/review                          waiting for approval, approved, sent back
//   #/timesheets/hours                           approved hours for payroll, with CSV export
// Hours come from start/finish less breaks (worked out as you type), or are
// typed directly. Approval freezes the cost; corrections reopen the week.
import { call, chip, date, dateTime, downloadCsv, flash, friendlyError, hashParams, options, safe, today } from "../lib/ui.js";
import { entryHours, mondayOf } from "../lib/validate.js";

const STATUS = { draft: ["Draft", "pending"], submitted: ["Waiting for approval", "info"], approved: ["Approved", "good"], rejected: ["Sent back", "bad"] };
const TYPES = [["ordinary", "Ordinary"], ["overtime_150", "Overtime ×1.5"], ["overtime_200", "Overtime ×2"], ["travel", "Travel time"]];
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtHours = h => (Math.round(h * 100) / 100).toLocaleString("en-AU", { maximumFractionDigits: 2 });

export async function renderTimesheets(view, ctx) {
  const sub = (ctx.sub || "").split("/")[0];
  if (sub === "review") return review(view, ctx);
  if (sub === "hours") return hours(view);
  return week(view, ctx);
}

const tabs = (ctx, on) => {
  const items = [["", "My week"]];
  if (ctx.can("time.approve") || ctx.can("projects.manage") || ctx.can("payroll.run")) items.push(["review", "Review"], ["hours", "Hours for payroll"]);
  return items.length > 1 ? `<nav class="tabs" aria-label="Timesheets">${items.map(([k, l]) => `<a class="tab ${k === on ? "on" : ""}" href="#/timesheets${k ? `/${k}` : ""}" ${k === on ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>` : "";
};

/* ---------------- A week ---------------- */

async function week(view, ctx) {
  const p = hashParams();
  const setup = await call("projects_setup");
  const st = { week: mondayOf(p.get("week") || setup.today), person: p.get("person") || "", data: null, entries: [] };
  const crew = setup.can.approve ? (await call("labour_people")).people.filter(x => x.id !== ctx.me.id) : [];
  const labourCodes = setup.costCodes.filter(c => c.active && c.category === "labour");

  const load = async () => {
    st.data = await call("timesheet_week", { weekStart: st.week, profileId: st.person || undefined });
    st.entries = st.data.entries.map(e => ({ ...e, hours: String(e.hours) }));
    if (!st.entries.length && st.data.can.edit) st.entries = [blank(st.week)];
    history.replaceState(null, "", `#/timesheets?week=${st.week}${st.person ? `&person=${st.person}` : ""}`);
    draw();
  };
  const blank = (d, prev) => ({ date: d, projectId: prev?.projectId || "", costCodeId: prev?.costCodeId || "", start: prev?.start || "", end: prev?.end || "",
    breakMinutes: prev?.breakMinutes ?? 30, hours: "", hourType: "ordinary", notes: "" });

  const draw = () => {
    const d = st.data, t = d.timesheet, edit = d.can.edit, own = d.profileId === ctx.me.id;
    const days = [...Array(7)].map((_, i) => addDays(st.week, i));
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS · TIMESHEETS</p><h1>${own ? "My timesheet" : safe(d.person)} ${t ? chip(...STATUS[t.status]) : ""}</h1>
        <p class="muted">${t?.enteredBy ? `Entered by ${safe(t.enteredBy)} · ` : ""}${t?.decidedBy ? `${t.status === "approved" ? "Approved" : "Decided"} by ${safe(t.decidedBy)} ${dateTime(t.decidedAt)}` : "Record your hours for each day, then submit the week for approval."}</p></div></header>
      ${tabs(ctx, "")}
      ${t?.status === "rejected" && t.comment ? `<p class="note">Sent back: ${safe(t.comment)}</p>` : ""}
      ${t?.status === "draft" && t.comment ? `<p class="note">Reopened: ${safe(t.comment)}</p>` : ""}
      <section class="panel">
        <div class="week-bar">
          <button type="button" class="btn" data-shift="-7" aria-label="Previous week">‹</button>
          <div class="fld"><label for="ts-week">Week starting</label><input id="ts-week" type="date" value="${safe(st.week)}"></div>
          <button type="button" class="btn" data-shift="7" aria-label="Next week">›</button>
          ${crew.length ? `<div class="fld"><label for="ts-person">Person</label><select id="ts-person">${options([["", "Me"], ...crew.map(c => [c.id, c.name])], st.person)}</select></div>` : ""}
          <p class="week-total"><span class="muted small">Week total</span><strong data-total></strong></p>
        </div>
        <form data-ts novalidate>
          ${days.map((day, i) => {
            const rows = st.entries.map((e, idx) => ({ e, idx })).filter(x => x.e.date === day);
            return `<fieldset class="day ${rows.length ? "" : "empty"}"><legend><span>${DAY[i]} ${date(day)}</span><span class="muted small" data-day-total="${day}"></span></legend>
              ${rows.map(({ e, idx }) => entryRow(e, idx, edit)).join("")}
              ${edit ? `<button type="button" class="link" data-add="${day}">+ Add hours for ${DAY[i]}</button>` : ""}
            </fieldset>`;
          }).join("")}
          <div class="actions">
            ${edit ? `<button class="btn" type="submit" data-act="save">Save</button><button class="btn primary" type="submit" data-act="submit">Submit for approval</button>` : ""}
            ${d.can.recall ? '<button class="btn" type="button" data-recall>Recall to change</button>' : ""}
            ${d.can.decide ? '<button class="btn primary" type="button" data-approve>Approve</button><button class="btn danger" type="button" data-reject>Send back</button>' : ""}
            ${d.can.reopen ? '<button class="btn" type="button" data-reopen>Reopen for correction</button>' : ""}
          </div>
        </form>
      </section>
      ${d.recent.length ? `<section class="panel"><h2>Recent weeks</h2><table class="tbl"><tbody>
        ${d.recent.map(r => `<tr><td><a href="#/timesheets?week=${safe(r.weekStart)}${st.person ? `&person=${safe(st.person)}` : ""}">Week of ${date(r.weekStart)}</a></td><td>${chip(...STATUS[r.status])}</td><td class="num mono">${fmtHours(r.totalHours)} h</td></tr>`).join("")}
      </tbody></table></section>` : ""}
      <p class="msg" data-msg role="status" aria-live="polite"></p>`;
    totals();
  };

  const entryRow = (e, idx, edit) => {
    const dis = edit ? "" : "disabled";
    const timed = e.start || e.end;
    return `<div class="entry" data-entry="${idx}">
      <div class="fld wide"><label for="e${idx}-p">Project</label><select id="e${idx}-p" data-f="projectId" ${dis}>${options([["", "No project (workshop / overhead)"], ...setup.projects.map(p => [p.id, `${p.number} ${p.name}`])], e.projectId || "")}</select></div>
      <div class="fld"><label for="e${idx}-c">Cost code</label><select id="e${idx}-c" data-f="costCodeId" ${dis}>${options([["", "—"], ...labourCodes.map(c => [c.id, `${c.code} ${c.name.replace(/^Labour - /, "")}`])], e.costCodeId || "")}</select></div>
      <div class="fld t"><label for="e${idx}-s">Start</label><input id="e${idx}-s" type="time" data-f="start" value="${safe(e.start)}" ${dis}></div>
      <div class="fld t"><label for="e${idx}-e">Finish</label><input id="e${idx}-e" type="time" data-f="end" value="${safe(e.end)}" ${dis}></div>
      <div class="fld t"><label for="e${idx}-b">Break (min)</label><input id="e${idx}-b" data-f="breakMinutes" inputmode="numeric" value="${safe(String(e.breakMinutes ?? 0))}" ${dis}></div>
      <div class="fld t"><label for="e${idx}-h">Hours</label><input id="e${idx}-h" data-f="hours" class="num" inputmode="decimal" value="${safe(e.hours)}" ${timed || !edit ? "readonly" : ""}></div>
      <div class="fld"><label for="e${idx}-y">Type</label><select id="e${idx}-y" data-f="hourType" ${dis}>${options(TYPES, e.hourType)}</select></div>
      <div class="fld wide"><label for="e${idx}-n">Notes</label><input id="e${idx}-n" data-f="notes" maxlength="300" value="${safe(e.notes)}" ${dis}></div>
      ${e.cost != null ? `<p class="muted small cost">Cost ${e.cost.toLocaleString("en-AU", { style: "currency", currency: "AUD" })}</p>` : ""}
      ${edit ? `<button type="button" class="link remove" data-remove="${idx}" aria-label="Remove this entry">Remove</button>` : ""}
    </div>`;
  };

  const read = () => {
    view.querySelectorAll("[data-entry]").forEach(el => {
      const e = st.entries[Number(el.dataset.entry)];
      el.querySelectorAll("[data-f]").forEach(f => { e[f.dataset.f] = f.value; });
    });
  };
  const totals = () => {
    read();
    let week = 0;
    const perDay = {};
    st.entries.forEach((e, idx) => {
      const row = view.querySelector(`[data-entry="${idx}"]`);
      if (!row) return;
      const h = e.start || e.end ? entryHours(e.start, e.end, e.breakMinutes) : Number(e.hours);
      const hoursInput = row.querySelector('[data-f="hours"]');
      if (e.start || e.end) { hoursInput.value = h == null ? "" : String(h); hoursInput.readOnly = true; e.hours = hoursInput.value; }
      else if (st.data.can.edit) hoursInput.readOnly = false;
      const bad = !(h > 0 && h <= 24);
      hoursInput.classList.toggle("invalid", bad && Boolean(e.hours || e.start || e.end));
      if (!bad) { week += h; perDay[e.date] = (perDay[e.date] || 0) + h; }
    });
    view.querySelectorAll("[data-day-total]").forEach(el => { const v = perDay[el.dataset.dayTotal]; el.textContent = v ? `${fmtHours(v)} h` : ""; el.classList.toggle("bad-text", v > 24); });
    view.querySelector("[data-total]").textContent = `${fmtHours(week)} h`;
  };

  await load();
  view.addEventListener("input", e => { if (e.target.closest("[data-entry]")) totals(); });
  view.addEventListener("change", async e => {
    if (e.target.id === "ts-week" && e.target.value) { st.week = mondayOf(e.target.value); try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); } }
    if (e.target.id === "ts-person") { st.person = e.target.value; try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); } }
  });
  view.addEventListener("click", async e => {
    const shift = e.target.closest("[data-shift]");
    const add = e.target.closest("[data-add]");
    const rm = e.target.closest("[data-remove]");
    try {
      if (shift) { st.week = addDays(st.week, Number(shift.dataset.shift)); await load(); return; }
      if (add) {
        read();
        const prev = [...st.entries].reverse().find(x => x.projectId) || st.entries[st.entries.length - 1];
        st.entries.push(blank(add.dataset.add, prev));
        draw();
        view.querySelector(`[data-entry="${st.entries.length - 1}"] select`)?.focus();
        return;
      }
      if (rm) { read(); st.entries.splice(Number(rm.dataset.remove), 1); draw(); return; }
      const id = st.data.timesheet?.id;
      if (e.target.closest("[data-recall]")) { await call("timesheet_reopen", { id }); await load(); flash(view, "Recalled. Make your changes and submit again.", "good"); }
      else if (e.target.closest("[data-approve]")) { await call("timesheet_decide", { id, approve: true }); await load(); flash(view, "Approved.", "good"); ctx.refreshCounts?.(); }
      else if (e.target.closest("[data-reject]")) {
        const comment = window.prompt("Send this week back? Say what needs fixing:", "");
        if (comment === null) return;
        await call("timesheet_decide", { id, approve: false, comment }); await load(); flash(view, "Sent back.", "good");
      } else if (e.target.closest("[data-reopen]")) {
        const reason = window.prompt("Reopen this approved week for correction? The costs are worked out again when it is re-approved. Reason:", "");
        if (reason === null) return;
        await call("timesheet_reopen", { id, reason }); await load(); flash(view, "Reopened.", "good");
      }
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-ts]")) return;
    e.preventDefault();
    read();
    const submit = e.submitter?.dataset.act === "submit";
    const entries = st.entries.filter(x => x.hours || x.start || x.end || x.projectId);
    if (view.querySelector("[data-entry] .invalid")) return flash(view, "Check the highlighted hours.", "bad");
    if (submit && !entries.length) return flash(view, "Add your hours before submitting.", "bad");
    view.querySelectorAll("button[type=submit]").forEach(b => { b.disabled = true; });
    try {
      await call("timesheet_save", { weekStart: st.week, profileId: st.person || undefined, entries, submit });
      await load();
      flash(view, submit ? "Submitted for approval." : "Saved.", "good");
    } catch (error) {
      flash(view, friendlyError(error), "bad");
      view.querySelectorAll("button[type=submit]").forEach(b => { b.disabled = false; });
    }
  });
}

/* ---------------- Review ---------------- */

async function review(view, ctx) {
  const st = { status: hashParams().get("status") || "submitted" };
  const load = async () => {
    const d = await call("timesheets_review", st);
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS · TIMESHEETS</p><h1>Review timesheets</h1>
        <p class="muted">Open a week to check it against the site diary, then approve it or send it back with a reason. You can't approve your own.</p></div></header>
      ${tabs(ctx, "review")}
      <section class="panel">
        <div class="tabs" role="tablist">${[["submitted", "Waiting"], ["rejected", "Sent back"], ["approved", "Approved"], ["draft", "Not submitted"]].map(([k, l]) =>
          `<button type="button" role="tab" aria-selected="${k === st.status}" class="${k === st.status ? "on" : ""}" data-st="${k}">${l}</button>`).join("")}</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Person</th><th scope="col">Week of</th><th scope="col" class="num">Hours</th><th scope="col" class="num">Overtime</th>
          <th scope="col" class="num">Projects</th><th scope="col">${st.status === "approved" ? "Approved" : "Submitted"}</th></tr></thead><tbody>
          ${d.timesheets.map(t => `<tr><td><a href="#/timesheets?week=${safe(t.weekStart)}${t.mine ? "" : `&person=${safe(t.profileId)}`}">${safe(t.person)}</a>${t.mine ? " <small>You</small>" : ""}</td>
            <td>${date(t.weekStart)}</td><td class="num mono">${fmtHours(t.totalHours)}</td><td class="num mono">${t.overtimeHours ? fmtHours(t.overtimeHours) : ""}</td>
            <td class="num">${t.projects}</td><td>${st.status === "approved" ? `${safe(t.decidedBy || "")} ${dateTime(t.decidedAt)}` : dateTime(t.submittedAt)}</td></tr>`).join("")
            || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>'}
        </tbody></table></div></section>`;
  };
  await load();
  view.addEventListener("click", async e => {
    const b = e.target.closest("[data-st]");
    if (!b) return;
    st.status = b.dataset.st;
    try { await load(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}

/* ---------------- Hours for payroll ---------------- */

async function hours(view) {
  const t = today();
  const st = { from: addDays(mondayOf(t), -14), to: addDays(mondayOf(t), -1) };
  let data = null;
  const draw = () => {
    const byPerson = {};
    for (const r of data?.rows || []) {
      const p = byPerson[r.person] ||= { ordinary: 0, overtime_150: 0, overtime_200: 0, travel: 0, total: 0 };
      p[r.hourType] += Number(r.hours); p.total += Number(r.hours);
    }
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">PROJECTS · TIMESHEETS</p><h1>Approved hours</h1>
        <p class="muted">Approved hours by person and type, ready for payroll. Pay runs arrive in Phase 5; until then export them for your payroll system.</p></div>
        ${data ? '<button class="btn" type="button" data-csv>Export CSV</button>' : ""}</header>
      <nav class="tabs" aria-label="Timesheets"><a class="tab" href="#/timesheets">My week</a><a class="tab" href="#/timesheets/review">Review</a><a class="tab on" aria-current="page" href="#/timesheets/hours">Hours for payroll</a></nav>
      <section class="panel">
        <form class="toolbar" data-run><div class="fld"><label for="h-from">From</label><input id="h-from" type="date" value="${safe(st.from)}"></div>
          <div class="fld"><label for="h-to">To</label><input id="h-to" type="date" value="${safe(st.to)}"></div><button class="btn primary" type="submit">Show</button></form>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Person</th>${TYPES.map(([, l]) => `<th scope="col" class="num">${l}</th>`).join("")}<th scope="col" class="num">Total</th></tr></thead><tbody>
          ${Object.entries(byPerson).map(([n, v]) => `<tr><td>${safe(n)}</td>${TYPES.map(([k]) => `<td class="num mono">${v[k] ? fmtHours(v[k]) : ""}</td>`).join("")}<td class="num mono"><strong>${fmtHours(v.total)}</strong></td></tr>`).join("")
            || '<tr><td colspan="6" class="muted">No approved hours in this range.</td></tr>'}
        </tbody></table></div></section><p class="msg" data-msg role="status" aria-live="polite"></p>`;
  };
  const run = async () => { data = await call("timesheet_hours", st); draw(); };
  await run();
  view.addEventListener("submit", async e => {
    if (!e.target.matches("[data-run]")) return;
    e.preventDefault();
    st.from = view.querySelector("#h-from").value; st.to = view.querySelector("#h-to").value;
    try { await run(); } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
  view.addEventListener("click", async e => {
    if (!e.target.closest("[data-csv]")) return;
    try {
      const d = await call("timesheet_hours", { ...st, export: true });
      downloadCsv(`approved-hours-${st.from}-to-${st.to}.csv`, [["Person", "Email", "Week starting", "Date", "Project", "Project name", "Cost code", "Type", "Start", "Finish", "Break (min)", "Hours", "Notes"],
        ...d.rows.map(r => [r.person, r.email, r.weekStart, r.date, r.project || "", r.projectName || "", r.costCode || "", r.hourType, r.start || "", r.end || "", r.breakMinutes, r.hours, r.notes])]);
      flash(view, "Exported. Exports are recorded in the audit log.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });
}
