// Company setup wizard (brief section 11). Each step saves on its own, so the
// wizard can be finished over several sittings. Bank accounts need a second
// person's approval before they become active.
import { call, chip, clearErrors, date, field, fieldError, flash, friendlyError, MONTHS, safe, selectField, STATES } from "../lib/ui.js";
import { formatAbn, formatAcn, previewNumber, setupMissing, validAbn, validAccountNumber, validAcn, validBsb, validEmail, validPostcode } from "../lib/validate.js";

const STEPS = ["Business", "Contact", "Tax and reporting", "Payroll", "Workers comp", "Banking", "Numbering", "Review"];
const TIMEZONES = [["Australia/Sydney", "Sydney, Canberra, Melbourne, Hobart"], ["Australia/Brisbane", "Brisbane"], ["Australia/Adelaide", "Adelaide"], ["Australia/Darwin", "Darwin"], ["Australia/Perth", "Perth"]];
const KIND_LABEL = { invoice: "Invoices", quote: "Quotes", purchase_order: "Purchase orders", credit_note: "Credit notes", bill: "Supplier bills", journal: "Journals", pay_run: "Pay runs" };
const PURPOSE = [["operating", "Operating"], ["payroll", "Payroll"], ["receipts", "Customer receipts"], ["tax", "Tax (GST/PAYG)"], ["other", "Other"]];

let data = null;
let step = 0;
let ctx = null;

export async function renderCompany(view, context) {
  ctx = context;
  data = await call("company_get");
  const wanted = Number(new URLSearchParams(location.hash.split("?")[1] || "").get("step"));
  step = data.canEdit ? (Number.isInteger(wanted) && wanted >= 1 && wanted <= STEPS.length ? wanted - 1 : step) : STEPS.length - 1;
  draw(view);
}

function draw(view) {
  const s = data.settings || {};
  const done = Boolean(s.setup_completed_at);
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">ADMINISTRATION</p><h1>Company settings</h1>
      <p class="muted">${done ? `Setup completed ${date(s.setup_completed_at)}. Changes save straight away and are recorded in the audit log.` : "Set up the company once; every invoice, payslip and report uses these details."}</p></div>
      ${data.canEdit ? "" : chip("Read only", "")}</header>
    ${data.canEdit ? `<ol class="stepper">${STEPS.map((name, i) => `<li><button type="button" data-step="${i}" class="${i === step ? "current" : ""}" ${i === step ? 'aria-current="step"' : ""}><span>${i + 1}</span>${safe(name)}</button></li>`).join("")}</ol>` : ""}
    <section class="panel" data-step-panel>${BUILD[step](s)}</section>
    <p class="msg" data-msg role="status" aria-live="polite"></p>`;
  bind(view);
}

/* ---------------- Steps ---------------- */

const addr = (prefix, a = {}) => `<div class="grid4">
  ${field({ id: `${prefix}_street`, label: "Street address", value: a.street, wide: true, attrs: 'autocomplete="street-address"' })}
  ${field({ id: `${prefix}_suburb`, label: "Suburb", value: a.suburb })}
  ${selectField({ id: `${prefix}_state`, label: "State", list: [["", "Choose…"], ...STATES], value: a.state })}
  ${field({ id: `${prefix}_postcode`, label: "Postcode", value: a.postcode, attrs: 'inputmode="numeric" maxlength="4"' })}</div>`;

const saveBar = (last = false) => `<div class="actions">${step > 0 ? '<button type="button" class="btn" data-prev>Back</button>' : ""}
  <button type="submit" class="btn primary">${last ? "Save" : "Save and continue"}</button></div>`;

const BUILD = [
  s => `<form data-form="business"><h2>Business details</h2>
    <div class="grid2">
      ${field({ id: "legal_name", label: "Legal name", value: s.legal_name, required: true, hint: "As registered with ASIC" })}
      ${field({ id: "trading_name", label: "Trading name", value: s.trading_name })}
      ${field({ id: "abn", label: "ABN", value: formatAbn(s.abn || ""), required: true, attrs: 'inputmode="numeric" maxlength="14"', hint: "11 digits. Checked against the ATO check-digit rule." })}
      ${field({ id: "acn", label: "ACN", value: formatAcn(s.acn || ""), attrs: 'inputmode="numeric" maxlength="11"', hint: "9 digits, for a company" })}
    </div>
    <div class="logo-row">${data.logoUrl ? `<img class="logo" src="${safe(data.logoUrl)}" alt="Current logo">` : '<span class="logo empty">No logo</span>'}
      <label class="btn file">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-logo></label>
      <small class="muted">PNG, JPG, WebP or SVG, up to 2 MB. Used on invoices, quotes and payslips.</small></div>
    ${saveBar()}</form>`,

  s => `<form data-form="contact"><h2>Contact and addresses</h2>
    <h3>Business address</h3>${addr("ba", s.business_address)}
    <label class="check"><input type="checkbox" data-same ${JSON.stringify(s.postal_address || {}) === JSON.stringify(s.business_address || {}) || !s.postal_address?.street ? "checked" : ""}> Postal address is the same</label>
    <div data-postal class="${!s.postal_address?.street || JSON.stringify(s.postal_address) === JSON.stringify(s.business_address) ? "hidden" : ""}"><h3>Postal address</h3>${addr("pa", s.postal_address)}</div>
    <div class="grid3">
      ${field({ id: "phone", label: "Phone", value: s.phone, required: true, type: "tel" })}
      ${field({ id: "email", label: "Accounts email", value: s.email, required: true, type: "email", hint: "Shown on invoices; replies come here" })}
      ${field({ id: "website", label: "Website", value: s.website, type: "url" })}
    </div>${saveBar()}</form>`,

  s => `<form data-form="tax"><h2>Tax and reporting</h2>
    <div class="grid3">
      ${selectField({ id: "gst_registered", label: "Registered for GST", list: [["true", "Yes"], ["false", "No"]], value: String(s.gst_registered ?? true) })}
      ${selectField({ id: "gst_basis", label: "GST reporting basis", list: [["accrual", "Accrual (invoice date)"], ["cash", "Cash (payment date)"]], value: s.gst_basis, hint: "Cash basis is only for GST turnover under $10 million" })}
      ${selectField({ id: "bas_frequency", label: "BAS lodgement", list: [["quarterly", "Quarterly"], ["monthly", "Monthly"], ["annual", "Annual"]], value: s.bas_frequency, hint: "Monthly is required at $20 million GST turnover or more" })}
      ${selectField({ id: "accounting_basis", label: "Accounting basis", list: [["accrual", "Accrual"], ["cash", "Cash"]], value: s.accounting_basis })}
      ${selectField({ id: "financial_year_start_month", label: "Financial year starts", list: MONTHS.map((m, i) => [String(i + 1), m]), value: String(s.financial_year_start_month || 7) })}
      ${selectField({ id: "timezone", label: "Time zone", list: TIMEZONES, value: s.timezone })}
    </div><p class="muted small">Currency is Australian dollars (AUD). Your accountant should confirm these settings before the first BAS.</p>${saveBar()}</form>`,

  s => `<form data-form="payroll"><h2>Payroll and operations</h2>
    <fieldset class="states"><legend>States where Panalo employs people or sends workers <span class="req" aria-hidden="true">*</span></legend>
      ${STATES.map(st => `<label class="check"><input type="checkbox" name="states" value="${st}" ${(s.states || []).includes(st) ? "checked" : ""}> ${st}</label>`).join("")}
      <small class="muted">Drives payroll tax, workers compensation, labour hire licensing and portable long service leave.</small><small class="err" data-err="states"></small></fieldset>
    <div class="grid3">
      ${selectField({ id: "pay_frequency", label: "Pay frequency", list: [["weekly", "Weekly"], ["fortnightly", "Fortnightly"], ["monthly", "Monthly"]], value: s.pay_frequency })}
      ${selectField({ id: "pay_day", label: "Pay day", list: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], value: s.pay_day })}
      ${field({ id: "super_clearing_house", label: "Super clearing house", value: s.super_clearing_house, hint: "The ATO's free clearing house closed on 1 July 2026" })}
    </div>
    <h3>Payroll contact</h3><div class="grid3">
      ${field({ id: "pc_name", label: "Name", value: s.payroll_contact?.name, required: true })}
      ${field({ id: "pc_email", label: "Email", value: s.payroll_contact?.email, type: "email" })}
      ${field({ id: "pc_phone", label: "Phone", value: s.payroll_contact?.phone, type: "tel" })}</div>
    <div class="note"><strong>Single Touch Payroll:</strong> export only. Panalo Accounts prepares and checks STP data; a registered provider sends it to the ATO. Super is due at the fund within 7 business days of each payday (Payday Super).</div>
    ${saveBar()}</form>`,

  s => {
    const states = (s.states || []).length ? s.states : ["NSW"];
    const wc = s.workers_comp || [];
    return `<form data-form="wc"><h2>Workers compensation</h2>
      <p class="muted">One policy for each state where Panalo has workers. Expiry dates trigger reminders in a later phase.</p>
      <table class="tbl form-tbl"><thead><tr><th scope="col">State</th><th scope="col">Insurer</th><th scope="col">Policy number</th><th scope="col">Expires</th></tr></thead><tbody>
      ${states.map(st => { const w = wc.find(x => x.state === st) || {}; return `<tr data-wc="${st}"><td><strong>${st}</strong></td>
        <td><input aria-label="${st} insurer" name="insurer" value="${safe(w.insurer)}"></td><td><input aria-label="${st} policy number" name="policy" value="${safe(w.policyNumber)}"></td>
        <td><input aria-label="${st} expiry" type="date" name="expires" value="${safe(w.expiresOn)}"></td></tr>`; }).join("")}
      </tbody></table>${(s.states || []).length ? "" : '<p class="muted small">Choose your states in the Payroll step to add more rows.</p>'}${saveBar()}</form>`;
  },

  s => `<form data-form="terms"><h2>Banking and payment terms</h2>
      <div class="grid3">${field({ id: "payment_terms_days", label: "Default payment terms (days)", value: s.payment_terms_days ?? 30, type: "number", attrs: 'min="0" max="120"' })}</div>
      <div class="actions"><button type="submit" class="btn">Save terms</button></div></form>
    <h3>Company bank accounts</h3>
    <p class="muted">A new account stays inactive until someone else with banking permission approves it. This stops a single person (or a fake email) redirecting payments.</p>
    <table class="tbl"><thead><tr><th scope="col">Account</th><th scope="col">BSB</th><th scope="col">Number</th><th scope="col">Use</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${data.bankAccounts.map(b => `<tr><td><strong>${safe(b.nickname)}</strong><small>${safe(b.accountName)}${b.showOnInvoices ? " · shown on invoices" : ""}</small></td>
        <td>${safe(b.bsb)}</td><td class="mono">${safe(b.accountNumber)}</td><td>${safe((PURPOSE.find(p => p[0] === b.purpose) || [0, b.purpose])[1])}</td>
        <td>${chip({ pending: "Waiting for approval", active: "Active", rejected: "Rejected", retired: "Retired" }[b.status], { pending: "pending", active: "good", rejected: "bad" }[b.status] || "")}</td>
        <td>${b.status === "active" && data.canEdit ? `<button type="button" class="link" data-retire="${safe(b.id)}">Retire</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No bank accounts yet.</td></tr>'}
    </tbody></table>
    <form data-form="bank" class="sub"><h3>Add a bank account</h3>
      <div class="grid3">
        ${field({ id: "b_nickname", label: "Name in Panalo Accounts", required: true, attrs: 'placeholder="Main operating"' })}
        ${field({ id: "b_account_name", label: "Account name (as the bank has it)", required: true })}
        ${selectField({ id: "b_purpose", label: "Used for", list: PURPOSE, value: "operating" })}
        ${field({ id: "b_bsb", label: "BSB", required: true, attrs: 'inputmode="numeric" maxlength="7" placeholder="062-000"' })}
        ${field({ id: "b_account_number", label: "Account number", required: true, attrs: 'inputmode="numeric" maxlength="12"' })}
        ${field({ id: "b_apca", label: "APCA user ID (optional)", attrs: 'inputmode="numeric" maxlength="6"', hint: "6 digits from your bank, for ABA payment files" })}
      </div>
      <label class="check"><input type="checkbox" id="b_show"> Show this account on invoices for customers to pay into</label>
      <div class="actions"><button type="submit" class="btn">Send for approval</button></div></form>
    <div class="actions"><button type="button" class="btn" data-prev>Back</button><button type="button" class="btn primary" data-next>Continue</button></div>`,

  () => `<form data-form="numbering"><h2>Document numbering</h2>
    <p class="muted">Numbers only move forward, so an issued number is never reused.</p>
    <table class="tbl form-tbl"><thead><tr><th scope="col">Document</th><th scope="col">Prefix</th><th scope="col">Next number</th><th scope="col">Digits</th><th scope="col">Next will be</th><th scope="col"><span class="sr-only">Save</span></th></tr></thead><tbody>
    ${data.numbering.sort((a, b) => Object.keys(KIND_LABEL).indexOf(a.kind) - Object.keys(KIND_LABEL).indexOf(b.kind)).map(n => `<tr data-kind="${safe(n.kind)}">
      <td><strong>${safe(KIND_LABEL[n.kind] || n.kind)}</strong></td>
      <td><input aria-label="${safe(KIND_LABEL[n.kind])} prefix" name="prefix" value="${safe(n.prefix)}" maxlength="10"></td>
      <td><input aria-label="${safe(KIND_LABEL[n.kind])} next number" name="next" type="number" min="${n.next_number}" value="${n.next_number}"></td>
      <td><input aria-label="${safe(KIND_LABEL[n.kind])} digits" name="padding" type="number" min="1" max="10" value="${n.padding}"></td>
      <td class="mono" data-preview>${safe(previewNumber(n.prefix, n.next_number, n.padding))}</td>
      <td><button type="button" class="link" data-save-number>Save</button></td></tr>`).join("")}
    </tbody></table>
    <div class="actions"><button type="button" class="btn" data-prev>Back</button><button type="button" class="btn primary" data-next>Continue</button></div></form>`,

  s => {
    const missing = setupMissing(s);
    const row = (k, v) => `<tr><th scope="row">${safe(k)}</th><td>${v || '<span class="muted">—</span>'}</td></tr>`;
    const a = x => x?.street ? safe(`${x.street}, ${x.suburb || ""} ${x.state || ""} ${x.postcode || ""}`) : "";
    return `<h2>Review</h2>
      ${missing.length ? `<p class="msg warn">Still needed before setup is complete: ${safe(missing.join(", "))}.</p>` : s.setup_completed_at ? `<p class="msg good">Setup complete.</p>` : '<p class="msg good">Everything required is in place.</p>'}
      <table class="tbl kv"><tbody>
        ${row("Legal name", safe(s.legal_name))}${row("Trading name", safe(s.trading_name))}${row("ABN", safe(formatAbn(s.abn || "")))}${row("ACN", safe(formatAcn(s.acn || "")))}
        ${row("Business address", a(s.business_address))}${row("Postal address", a(s.postal_address))}${row("Phone", safe(s.phone))}${row("Email", safe(s.email))}${row("Website", safe(s.website))}
        ${row("GST", s.gst_registered ? `Registered, ${safe(s.gst_basis)} basis, BAS ${safe(s.bas_frequency)}` : "Not registered")}
        ${row("Financial year", `Starts ${safe(MONTHS[(s.financial_year_start_month || 7) - 1])}`)}${row("Accounting basis", safe(s.accounting_basis))}
        ${row("States", safe((s.states || []).join(", ")))}${row("Pay cycle", `${safe(s.pay_frequency)}, paid ${safe(s.pay_day)}`)}
        ${row("Payroll contact", safe([s.payroll_contact?.name, s.payroll_contact?.email, s.payroll_contact?.phone].filter(Boolean).join(" · ")))}
        ${row("Super clearing house", safe(s.super_clearing_house))}${row("Workers compensation", safe((s.workers_comp || []).map(w => `${w.state}: ${w.insurer || "?"}`).join(", ")))}
        ${row("Payment terms", `${s.payment_terms_days ?? 30} days`)}${row("Active bank accounts", String(data.bankAccounts.filter(b => b.status === "active").length))}
      </tbody></table>
      ${data.canEdit ? `<div class="actions"><button type="button" class="btn" data-prev>Back</button>
        <button type="button" class="btn primary" data-finish ${missing.length ? "disabled" : ""}>${s.setup_completed_at ? "Saved" : "Finish setup"}</button></div>` : ""}`;
  }
];

/* ---------------- Saving ---------------- */

function readAddress(form, prefix) {
  return ["street", "suburb", "state", "postcode"].reduce((o, k) => ({ ...o, [k]: form.querySelector(`#${prefix}_${k}`).value.trim() }), {});
}

function collect(form, view) {
  const v = id => form.querySelector(`#${id}`)?.value.trim() ?? "";
  const fail = (id, text) => { fieldError(view, id, text); throw Object.assign(new Error(text), { handled: true }); };
  switch (form.dataset.form) {
    case "business":
      if (v("legal_name").length < 2) fail("legal_name", "Enter the legal name.");
      if (v("abn") && !validAbn(v("abn"))) fail("abn", "That ABN isn't valid. Check the 11 digits.");
      if (v("acn") && !validAcn(v("acn"))) fail("acn", "That ACN isn't valid. Check the 9 digits.");
      return { legal_name: v("legal_name"), trading_name: v("trading_name"), abn: v("abn"), acn: v("acn") };
    case "contact": {
      const ba = readAddress(form, "ba");
      const same = form.querySelector("[data-same]").checked;
      const pa = same ? ba : readAddress(form, "pa");
      if (!ba.street) fail("ba_street", "Enter the street address.");
      if (!validPostcode(ba.postcode)) fail("ba_postcode", "A postcode is 4 digits.");
      if (!ba.state) fail("ba_state", "Choose a state.");
      if (!same && pa.postcode && !validPostcode(pa.postcode)) fail("pa_postcode", "A postcode is 4 digits.");
      if (!v("phone")) fail("phone", "Enter a phone number.");
      if (!validEmail(v("email"))) fail("email", "Enter a valid email address.");
      return { business_address: ba, postal_address: pa, phone: v("phone"), email: v("email"), website: v("website") };
    }
    case "tax":
      return { gst_registered: v("gst_registered") === "true", gst_basis: v("gst_basis"), bas_frequency: v("bas_frequency"),
        accounting_basis: v("accounting_basis"), financial_year_start_month: Number(v("financial_year_start_month")), timezone: v("timezone") };
    case "payroll": {
      const states = [...form.querySelectorAll('input[name="states"]:checked')].map(i => i.value);
      if (!states.length) fail("states", "Choose at least one state.");
      if (!v("pc_name")) fail("pc_name", "Enter the payroll contact's name.");
      if (v("pc_email") && !validEmail(v("pc_email"))) fail("pc_email", "Enter a valid email address.");
      return { states, pay_frequency: v("pay_frequency"), pay_day: v("pay_day"), super_clearing_house: v("super_clearing_house"),
        payroll_contact: { name: v("pc_name"), email: v("pc_email"), phone: v("pc_phone") } };
    }
    case "wc":
      return { workers_comp: [...form.querySelectorAll("[data-wc]")].map(r => ({ state: r.dataset.wc, insurer: r.querySelector('[name="insurer"]').value.trim(),
        policyNumber: r.querySelector('[name="policy"]').value.trim(), expiresOn: r.querySelector('[name="expires"]').value || null })) };
    case "terms": {
      const days = Number(v("payment_terms_days"));
      if (!Number.isInteger(days) || days < 0 || days > 120) fail("payment_terms_days", "Between 0 and 120 days.");
      return { payment_terms_days: days };
    }
    default: return null;
  }
}

function go(view, to) {
  step = Math.max(0, Math.min(STEPS.length - 1, to));
  history.replaceState(null, "", `#/company?step=${step + 1}`);
  draw(view);
  view.querySelector("h2")?.scrollIntoView({ block: "nearest" });
}

function bind(view) {
  view.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => go(view, Number(b.dataset.step))));
  view.querySelectorAll("[data-prev]").forEach(b => b.addEventListener("click", () => go(view, step - 1)));
  view.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => go(view, step + 1)));
  view.querySelector("[data-same]")?.addEventListener("change", e => view.querySelector("[data-postal]").classList.toggle("hidden", e.target.checked));

  view.querySelectorAll("form[data-form]").forEach(form => form.addEventListener("submit", async event => {
    event.preventDefault();
    clearErrors(view);
    const button = form.querySelector('button[type="submit"]');
    try {
      if (form.dataset.form === "bank") return await addBank(form, view);
      const patch = collect(form, view);
      if (!patch) return;
      button.disabled = true;
      flash(view, "Saving…");
      data = await call("company_save", { patch });
      flash(view, "Saved.", "good");
      if (form.dataset.form === "terms") return draw(view);
      go(view, step + 1);
      flash(view, "Saved.", "good");
    } catch (error) {
      if (!error.handled) flash(view, friendlyError(error), "bad");
      if (button) button.disabled = false;
    }
  }));

  view.querySelector("[data-logo]")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      flash(view, "Uploading logo…");
      const prep = await call("logo_prepare_upload", { fileName: file.name, size: file.size });
      const res = await fetch(prep.signedUrl, { method: "PUT", headers: { "Content-Type": prep.contentType }, body: file });
      if (!res.ok) throw new Error(`The upload failed (${res.status}). Please try again.`);
      await call("logo_attach", { path: prep.path, fileName: file.name, size: file.size });
      data = await call("company_get");
      draw(view);
      flash(view, "Logo updated.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  });

  view.querySelectorAll("[data-retire]").forEach(b => b.addEventListener("click", async () => {
    const reason = window.prompt("Retire this bank account? It stays on record. Give a reason:", "");
    if (reason === null) return;
    try {
      await call("bank_account_retire", { accountId: b.dataset.retire, reason });
      data = await call("company_get");
      draw(view);
      flash(view, "Account retired.", "good");
    } catch (error) { flash(view, friendlyError(error), "bad"); }
  }));

  view.querySelectorAll("[data-kind]").forEach(row => {
    const upd = () => { row.querySelector("[data-preview]").textContent = previewNumber(row.querySelector('[name="prefix"]').value, row.querySelector('[name="next"]').value, row.querySelector('[name="padding"]').value); };
    row.querySelectorAll("input").forEach(i => i.addEventListener("input", upd));
    row.querySelector("[data-save-number]").addEventListener("click", async () => {
      try {
        await call("numbering_save", { kind: row.dataset.kind, prefix: row.querySelector('[name="prefix"]').value, nextNumber: Number(row.querySelector('[name="next"]').value), padding: Number(row.querySelector('[name="padding"]').value) });
        data = await call("company_get");
        flash(view, `${KIND_LABEL[row.dataset.kind]} numbering saved.`, "good");
      } catch (error) { flash(view, friendlyError(error), "bad"); }
    });
  });

  view.querySelector("[data-finish]")?.addEventListener("click", async e => {
    e.target.disabled = true;
    try {
      await call("company_complete");
      data = await call("company_get");
      draw(view);
      flash(view, "Company setup complete.", "good");
      ctx.refreshCounts();
    } catch (error) { flash(view, friendlyError(error), "bad"); e.target.disabled = false; }
  });
}

async function addBank(form, view) {
  const v = id => form.querySelector(`#${id}`).value.trim();
  const fail = (id, text) => { fieldError(view, id, text); };
  if (v("b_nickname").length < 2) return fail("b_nickname", "Give the account a name.");
  if (v("b_account_name").length < 2) return fail("b_account_name", "Enter the account name.");
  if (!validBsb(v("b_bsb"))) return fail("b_bsb", "A BSB is 6 digits, like 062-000.");
  if (!validAccountNumber(v("b_account_number"))) return fail("b_account_number", "An account number is 5 to 10 digits.");
  if (v("b_apca") && !/^\d{6}$/.test(v("b_apca"))) return fail("b_apca", "The APCA user ID is 6 digits.");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await call("bank_account_request", { nickname: v("b_nickname"), accountName: v("b_account_name"), bsb: v("b_bsb"), accountNumber: v("b_account_number"),
      apcaUserId: v("b_apca") || null, purpose: v("b_purpose"), showOnInvoices: form.querySelector("#b_show").checked });
    data = await call("company_get");
    draw(view);
    flash(view, "Sent for approval. Someone else with banking permission must approve it before it can be used.", "good");
    ctx.refreshCounts();
  } catch (error) {
    flash(view, friendlyError(error), "bad");
    button.disabled = false;
  }
}
