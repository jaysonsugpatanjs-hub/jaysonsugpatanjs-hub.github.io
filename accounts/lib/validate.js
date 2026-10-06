// Browser-side checks for Panalo Accounts forms. The server and database run
// the same checks; these just give people the message before they submit.

const digits = value => String(value ?? "").replace(/[\s-]/g, "");

/** ATO ABN check: subtract 1 from the first digit, weight, sum, divisible by 89. */
export function validAbn(value) {
  const d = digits(value);
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  return [...d].reduce((sum, c, i) => sum + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0) % 89 === 0;
}

/** ASIC ACN check digit: weights 8..1 on the first 8 digits, complement of the sum mod 10. */
export function validAcn(value) {
  const d = digits(value);
  if (!/^\d{9}$/.test(d)) return false;
  const s = [...d.slice(0, 8)].reduce((sum, c, i) => sum + Number(c) * (8 - i), 0);
  return (10 - (s % 10)) % 10 === Number(d[8]);
}

export const validBsb = value => /^\d{6}$/.test(digits(value));
export const validAccountNumber = value => /^\d{5,10}$/.test(digits(value));
export const validPostcode = value => /^\d{4}$/.test(String(value ?? "").trim());
export const validEmail = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value ?? "").trim());

export function formatAbn(value) {
  const d = digits(value);
  return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : String(value ?? "");
}
export function formatAcn(value) {
  const d = digits(value);
  return d.length === 9 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : String(value ?? "");
}
export function formatBsb(value) {
  const d = digits(value);
  return d.length === 6 ? `${d.slice(0, 3)}-${d.slice(3)}` : String(value ?? "");
}

/** What the setup wizard still needs before it can be finished (mirrors company_setup_complete). */
export function setupMissing(s) {
  const c = s || {};
  const missing = [];
  if (!c.abn) missing.push("ABN");
  if (!c.business_address?.street || !c.business_address?.postcode) missing.push("business address");
  if (!c.email) missing.push("email");
  if (!c.phone) missing.push("phone");
  if (!(c.states || []).length) missing.push("states you operate in");
  if (!c.payroll_contact?.name) missing.push("payroll contact");
  return missing;
}

/** Preview of the next document number, e.g. INV-01001. */
export function previewNumber(prefix, next, padding) {
  const n = Math.max(1, Math.floor(Number(next) || 1));
  return `${String(prefix || "").toUpperCase()}${String(n).padStart(Math.min(10, Math.max(1, Number(padding) || 1)), "0")}`;
}

/** GST for one journal line, to the cent, half up (mirrors ledger_build_lines). */
export function lineGst(amount, rate, amountsAre) {
  if (!rate || amountsAre === "no_tax") return 0;
  const cents = Math.round(amount * 100);
  const gst = amountsAre === "inclusive" ? (cents * rate) / (1 + rate) : cents * rate;
  return Math.round(gst + 1e-9) / 100;
}

/** Totals of a journal as the ledger will post it (GST lines included). */
export function journalTotals(lines, rates, amountsAre) {
  let debit = 0, credit = 0;
  for (const l of lines) {
    const dr = Number(l.debit) || 0, cr = Number(l.credit) || 0;
    const amount = dr || cr;
    const gst = lineGst(amount, rates[l.taxCodeId] || 0, amountsAre);
    const posted = amountsAre === "exclusive" ? amount + gst : amount;
    if (dr) debit += posted; else credit += posted;
  }
  return { debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 };
}
