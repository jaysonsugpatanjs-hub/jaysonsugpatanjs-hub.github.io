// Reads bank statement files in the browser: CSV (any column layout, mapped
// on screen), OFX/QFX and QIF. Produces rows of
// { date: "yyyy-mm-dd", amount: "-12.34", description, reference, balance, externalId }
// that the server checks again before importing. Nothing here talks to the network.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, "0");

function validDate(y, m, d) {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Dates as banks write them. order: "dmy" (Australian, the default), "mdy" or "ymd". */
export function parseDate(value, order = "dmy") {
  const s = String(value ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m && s.length >= 8 && /^\d{8}/.test(s)) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\s-/]([A-Za-z]{3,4})[A-Za-z]*[\s-/,]+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([A-Za-z]{3,4})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return validDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  // QIF pads with spaces ("1/ 5'24") and uses ' before the year.
  m = /^(\d{1,2})[-/.'](\d{1,2})[-/.'](\d{2,4})$/.exec(s.replace(/\s+/g, ""));
  if (m) return order === "mdy" ? validDate(+m[3], +m[1], +m[2]) : validDate(+m[3], +m[2], +m[1]);
  return null;
}

/** "$1,234.56", "-1,234.56", "(1,234.56)", "1,234.56 CR", "1234.56-" -> "1234.56" or "-1234.56". Null if unreadable. */
export function parseAmount(value) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\s*DR$/i.test(s)) { sign = -sign; s = s.replace(/\s*DR$/i, ""); }
  else if (/\s*CR$/i.test(s)) s = s.replace(/\s*CR$/i, "");
  if (/-$/.test(s)) { sign = -sign; s = s.slice(0, -1); }
  s = s.replace(/\bAUD\b/i, "").replace(/[$\s,]/g, "");
  if (/[a-z]/i.test(s)) return null;
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) { sign = -sign; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100) * sign;
  return (cents / 100).toFixed(2);
}

/** CSV with quotes, embedded commas and newlines. Returns rows of cells. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const src = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; }  // a quote only opens a quoted cell at its start
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== "")) rows.push(row);
  return rows.map(r => r.map(x => x.trim()));
}

const HEAD = {
  date: /^(transaction\s*)?date|^posted|^effective/i,
  amount: /^amount|^transaction amount|^value$/i,
  debit: /debit|withdraw|money out|paid out/i,
  credit: /credit|deposit|money in|paid in/i,
  description: /description|narrative|details|particulars|transaction$|memo|payee/i,
  reference: /reference|^ref|cheque|check|serial/i,
  balance: /balance/i
};

/** Guesses which column is which. The person can change it on screen. */
export function guessCsvMapping(rows, order = "dmy") {
  const first = rows[0] || [];
  const isHeader = first.length > 1 && first.some(c => /[a-z]/i.test(c)) && !first.some(c => parseDate(c, order)) && first.filter(c => parseAmount(c) != null).length === 0;
  const body = rows.slice(isHeader ? 1 : 0, (isHeader ? 1 : 0) + 30);
  const cols = Math.max(0, ...rows.map(r => r.length));
  const share = test => Array.from({ length: cols }, (_, i) => body.length ? body.filter(r => test(r[i] ?? "")).length / body.length : 0);
  const dateShare = share(v => parseDate(v, order) != null);
  const numShare = share(v => v !== "" && parseAmount(v) != null);
  const textLen = Array.from({ length: cols }, (_, i) => body.reduce((t, r) => t + ((r[i] && parseAmount(r[i]) == null && !parseDate(r[i], order)) ? r[i].length : 0), 0));
  const pick = (re, ok = () => true) => isHeader ? first.findIndex((h, i) => re.test(h) && ok(i)) : -1;
  const m = { header: isHeader, date: -1, amount: -1, debit: -1, credit: -1, description: -1, reference: -1, balance: -1 };
  m.date = pick(HEAD.date);
  if (m.date < 0) m.date = dateShare.findIndex(s => s >= 0.8);
  m.balance = pick(HEAD.balance);
  m.amount = pick(HEAD.amount, i => i !== m.balance);
  if (m.amount < 0) {
    m.debit = pick(HEAD.debit, i => i !== m.balance);
    m.credit = pick(HEAD.credit, i => i !== m.balance && i !== m.debit);
    if (m.debit < 0 || m.credit < 0) {
      m.debit = m.credit = -1;
      m.amount = numShare.findIndex((s, i) => s >= 0.8 && i !== m.date && i !== m.balance);
    }
  }
  m.description = pick(HEAD.description, i => ![m.date, m.amount, m.debit, m.credit, m.balance].includes(i));
  if (m.description < 0) {
    let best = -1;
    textLen.forEach((l, i) => { if (![m.date, m.amount, m.debit, m.credit, m.balance].includes(i) && (best < 0 || l > textLen[best])) best = i; });
    m.description = best;
  }
  m.reference = pick(HEAD.reference, i => ![m.date, m.amount, m.debit, m.credit, m.balance, m.description].includes(i));
  // Headerless files with a trailing number column after the amount usually end with the balance (CBA, ANZ).
  if (!isHeader && m.balance < 0 && m.amount >= 0) {
    const later = numShare.findIndex((s, i) => s >= 0.8 && i > m.amount);
    if (later >= 0) m.balance = later;
  }
  return m;
}

/** Applies a mapping. Debit/credit columns: debits become negative. flip turns the signs round (credit-card style files). */
export function rowsFromCsv(rows, m, { order = "dmy", flip = false } = {}) {
  const out = [], errors = [];
  rows.slice(m.header ? 1 : 0).forEach((r, i) => {
    const line = i + (m.header ? 2 : 1);
    const date = parseDate(r[m.date], order);
    let amount = null;
    if (m.amount >= 0) amount = parseAmount(r[m.amount]);
    else {
      const d = parseAmount(r[m.debit]), c = parseAmount(r[m.credit]);
      if (d != null && Number(d) !== 0) amount = (-Math.abs(Number(d))).toFixed(2);
      else if (c != null && Number(c) !== 0) amount = Math.abs(Number(c)).toFixed(2);
    }
    const description = String(r[m.description] ?? "").trim() || String(r[m.reference] ?? "").trim();
    if (!date && !amount && !description) return;
    if (!date) return errors.push(`Line ${line}: the date "${r[m.date] ?? ""}" isn't readable.`);
    if (amount == null || Number(amount) === 0) return errors.push(`Line ${line}: no amount.`);
    if (flip) amount = (-Number(amount)).toFixed(2);
    const balance = m.balance >= 0 ? parseAmount(r[m.balance]) : null;
    out.push({ date, amount, description: description || "(no description)", reference: m.reference >= 0 ? String(r[m.reference] ?? "").trim() : "", balance, externalId: null });
  });
  return { rows: out, errors };
}

const tag = (block, name) => {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? m[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
};

/** OFX / QFX, SGML or XML. */
export function parseOfx(text) {
  const src = String(text ?? "");
  const rows = [], errors = [];
  const blocks = src.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>/i)[0]);
  blocks.forEach((b, i) => {
    const date = parseDate(tag(b, "DTPOSTED").slice(0, 8));
    const amount = parseAmount(tag(b, "TRNAMT"));
    const name = tag(b, "NAME"), memo = tag(b, "MEMO");
    if (!date || amount == null || Number(amount) === 0) return errors.push(`Transaction ${i + 1}: missing date or amount.`);
    rows.push({ date, amount, description: [name, memo && memo !== name ? memo : ""].filter(Boolean).join(" ") || tag(b, "TRNTYPE") || "(no description)",
      reference: tag(b, "CHECKNUM") || tag(b, "REFNUM"), balance: null, externalId: tag(b, "FITID") || null });
  });
  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(src);
  const balance = ledger ? parseAmount(tag(ledger[1], "BALAMT")) : null;
  const balanceDate = ledger ? parseDate(tag(ledger[1], "DTASOF").slice(0, 8)) : null;
  return { rows, errors, balance, balanceDate };
}

/** QIF (bank accounts). */
export function parseQif(text, order = "dmy") {
  const rows = [], errors = [];
  let cur = {};
  let n = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("!")) continue;
    const k = line[0], v = line.slice(1).trim();
    if (k === "^") {
      n++;
      const date = parseDate(cur.D, order);
      const amount = parseAmount(cur.T ?? cur.U);
      if (!date || amount == null || Number(amount) === 0) errors.push(`Transaction ${n}: missing date or amount.`);
      else rows.push({ date, amount, description: [cur.P, cur.M && cur.M !== cur.P ? cur.M : ""].filter(Boolean).join(" ") || "(no description)",
        reference: cur.N || "", balance: null, externalId: null });
      cur = {};
    } else cur[k] = v;
  }
  return { rows, errors };
}

export function detectFormat(fileName, text) {
  const name = String(fileName || "").toLowerCase();
  const head = String(text || "").slice(0, 500);
  if (/\.(ofx|qfx)$/.test(name) || /<OFX>|OFXHEADER/i.test(head)) return "ofx";
  if (/\.qif$/.test(name) || /^!Type:/im.test(head)) return "qif";
  return "csv";
}
