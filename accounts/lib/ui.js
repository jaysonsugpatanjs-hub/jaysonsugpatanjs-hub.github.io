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
