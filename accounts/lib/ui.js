// Small DOM and formatting helpers shared by the Accounts screens.
import { api, config, friendlyError } from "../../training/auth.js";

export const call = (action, body = {}) => api(config.financeFunction, { action, ...body });
export { friendlyError };

export function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const TZ = "Australia/Sydney";
export function date(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: TZ }).format(new Date(iso));
}
export function dateTime(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(new Date(iso));
}

export const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function options(list, selected) {
  return list.map(o => {
    const [value, label] = Array.isArray(o) ? o : [o, o];
    return `<option value="${safe(value)}" ${String(value) === String(selected ?? "") ? "selected" : ""}>${safe(label)}</option>`;
  }).join("");
}

/** A labelled form field. */
export function field({ id, label, value = "", type = "text", hint = "", required = false, attrs = "", wide = false }) {
  return `<div class="fld${wide ? " wide" : ""}"><label for="${id}">${safe(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ""}</label>
    <input id="${id}" name="${id}" type="${type}" value="${safe(value)}" ${required ? "required" : ""} ${attrs}>
    ${hint ? `<small>${safe(hint)}</small>` : ""}<small class="err" data-err="${id}"></small></div>`;
}

export function selectField({ id, label, list, value, hint = "", attrs = "" }) {
  return `<div class="fld"><label for="${id}">${safe(label)}</label><select id="${id}" name="${id}" ${attrs}>${options(list, value)}</select>
    ${hint ? `<small>${safe(hint)}</small>` : ""}<small class="err" data-err="${id}"></small></div>`;
}

export function chip(text, tone = "") {
  return `<span class="chip ${tone}">${safe(text)}</span>`;
}

/** Shows a short-lived message in the page's status line. */
export function flash(root, text, tone = "") {
  const el = root.querySelector("[data-msg]") || document.getElementById("app-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${tone}`;
}

export function fieldError(root, id, text) {
  const el = root.querySelector(`[data-err="${id}"]`);
  if (el) el.textContent = text;
  const input = root.querySelector(`#${CSS.escape(id)}`);
  input?.classList.toggle("invalid", Boolean(text));
  if (text) input?.focus();
}

export function clearErrors(root) {
  root.querySelectorAll("[data-err]").forEach(e => { e.textContent = ""; });
  root.querySelectorAll(".invalid").forEach(e => e.classList.remove("invalid"));
}

/* ---------------- Money, dates and exports ---------------- */

const AUD = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 1234.5 -> "1,234.50"; negatives in brackets, as accountants read them. */
export function money(value, { blankZero = false } = {}) {
  const n = Number(value) || 0;
  if (blankZero && Math.abs(n) < 0.005) return "";
  return n < 0 ? `(${AUD.format(-n)})` : AUD.format(n);
}
/** "2,200.00" -> 2200; returns NaN for anything that isn't an amount. */
export function parseMoney(text) {
  const t = String(text ?? "").replace(/[,\s$]/g, "");
  if (t === "") return 0;
  return /^\d+(\.\d{0,2})?$/.test(t) ? Number(t) : NaN;
}
export function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
export function addMonths(isoDate, n) {
  const [y, m] = isoDate.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
export function endOfMonth(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function monthLabel(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${y}`;
}
export function hashParams() {
  return new URLSearchParams(location.hash.split("?")[1] || "");
}

/** Downloads rows as a CSV file (Excel-compatible, with a BOM). */
export function downloadCsv(filename, rows) {
  const cell = v => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export const TYPE_LABEL = { asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", cost_of_sales: "Cost of sales",
  expense: "Operating expenses", other_income: "Other income", other_expense: "Other expenses" };
export const TYPE_ORDER = ["asset", "liability", "equity", "revenue", "cost_of_sales", "expense", "other_income", "other_expense"];
