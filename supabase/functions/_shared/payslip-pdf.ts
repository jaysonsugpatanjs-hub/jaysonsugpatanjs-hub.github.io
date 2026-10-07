// A4 payslip. Shows what the Fair Work Regulations 2009 (reg 3.46) require on
// a payslip: employer name and ABN, employee name, pay period, payment date,
// gross and net pay, each loading, allowance, bonus or penalty separately, the
// hourly rate and hours (or the annual salary), each deduction with who it was
// paid to, and the super contributed and the fund it goes to.
// https://www.fairwork.gov.au/pay-and-wages/paying-wages/pay-slips
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export type PayslipInput = {
  employer: { legalName: string; tradingName?: string | null; abn?: string | null; address?: string; phone?: string | null; email?: string | null };
  payRun: { number: string; periodStart: string; periodEnd: string; paymentDate: string };
  employee: { name: string; number?: string | null; basis?: string; payBasis?: string; annualSalary?: number | null; award?: string; classification?: string;
    fund?: string; fundUsi?: string | null; member?: string | null; bank?: string | null };
  lines: { code: string; kind: string; name: string; description: string; hours: number | null; rate: number | null; amount: number; payee?: string | null }[];
  totals: { gross: number; payg: number; stsl: number; salarySacrifice: number; deductions: number; reimbursements: number; superGuarantee: number; net: number };
  ytd?: { gross: number; payg: number; super: number; net: number } | null;
  leave?: { type: string; balance: number }[];
};

const latin = (v: unknown) => String(v ?? "").replace(/[^\x20-\x7E -ÿ]/g, "-");
const money = (n: number) => {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${s}` : `$${s}`;
};
const day = (iso?: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
const fmtAbn = (a?: string | null) => (a ? a.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4") : "");
const BASIS: Record<string, string> = { full_time: "Full-time", part_time: "Part-time", casual: "Casual" };

export async function createPayslipPdf(p: PayslipInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin(`Payslip ${p.employee.name} ${p.payRun.paymentDate}`));
  pdf.setAuthor(latin(p.employer.legalName));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.08, 0.09), grey = rgb(0.4, 0.4, 0.44), line = rgb(0.82, 0.82, 0.85), gold = rgb(0.96, 0.72, 0.0), band = rgb(0.96, 0.96, 0.97);
  const [W, H, M] = [595.28, 841.89, 42];
  let page = pdf.addPage([W, H]);
  const text = (t: string, x: number, y: number, o: { size?: number; font?: any; color?: any; right?: boolean } = {}) => {
    const size = o.size ?? 9, font = o.font ?? regular, s = latin(t);
    page.drawText(s, { x: o.right ? x - font.widthOfTextAtSize(s, size) : x, y, size, font, color: o.color ?? ink });
  };
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: gold });
  let y = H - 36;
  // A long payslip carries on over the page.
  const room = (h: number) => {
    if (y - h >= 48) return;
    page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: gold });
    y = H - 36;
    text(`${p.employee.name} - payslip ${p.payRun.number} (continued)`, M, y, { size: 9, font: bold });
    y -= 24;
  };
  text(p.employer.tradingName || p.employer.legalName, M, y, { size: 13, font: bold });
  text("PAYSLIP", W - M, y, { size: 18, font: bold, right: true });
  const emp = [p.employer.tradingName && p.employer.tradingName !== p.employer.legalName ? p.employer.legalName : "", p.employer.abn ? `ABN ${fmtAbn(p.employer.abn)}` : "",
    p.employer.address || "", [p.employer.phone, p.employer.email].filter(Boolean).join("  -  ")].filter(Boolean);
  emp.forEach((t, i) => text(t, M, y - 14 - i * 11, { size: 8, color: grey }));
  y -= 14 + emp.length * 11 + 18;

  // Employee and period.
  text("EMPLOYEE", M, y, { size: 7, font: bold, color: grey });
  const left = [p.employee.name, p.employee.number ? `Employee no. ${p.employee.number}` : "",
    [BASIS[p.employee.basis || ""] || "", p.employee.payBasis === "salary" && p.employee.annualSalary ? `annual salary ${money(p.employee.annualSalary)}` : ""].filter(Boolean).join(", "),
    [p.employee.award, p.employee.classification].filter(Boolean).join(" - ")].filter(Boolean);
  left.forEach((t, i) => text(t, M, y - 13 - i * 12, { size: i ? 9 : 10, font: i ? regular : bold }));
  const facts: [string, string][] = [["Pay period", `${day(p.payRun.periodStart)} to ${day(p.payRun.periodEnd)}`], ["Payment date", day(p.payRun.paymentDate)], ["Pay run", p.payRun.number]];
  facts.forEach(([k, v], i) => { text(k, W - M - 220, y - i * 13, { color: grey }); text(v, W - M - 120, y - i * 13, { font: bold }); });
  y -= Math.max(left.length * 12 + 13, facts.length * 13) + 18;

  // Lines.
  const head = (title: string) => {
    room(48);
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: band });
    text(title, M + 4, y, { size: 8, font: bold, color: grey });
    text("Hours", W - M - 200, y, { size: 8, font: bold, color: grey, right: true });
    text("Rate", W - M - 110, y, { size: 8, font: bold, color: grey, right: true });
    text("Amount", W - M - 4, y, { size: 8, font: bold, color: grey, right: true });
    y -= 18;
  };
  const row = (label: string, hours: number | null, rate: number | null, amount: number, sub?: string) => {
    room(sub ? 23 : 12);
    text(label, M + 4, y);
    if (hours != null) text(Number(hours).toLocaleString("en-AU", { maximumFractionDigits: 2 }), W - M - 200, y, { right: true });
    if (rate != null) text(`$${Number(rate).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`, W - M - 110, y, { right: true });
    text(money(amount), W - M - 4, y, { right: true });
    y -= 12;
    if (sub) { text(sub, M + 14, y, { size: 7.5, color: grey }); y -= 11; }
    page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.4, color: line });
  };
  head("EARNINGS AND ALLOWANCES");
  for (const l of p.lines.filter(x => x.kind === "earning" || x.kind === "allowance")) row(l.description || l.name, l.hours, l.rate, l.amount, l.description && l.description !== l.name ? l.name : undefined);
  y -= 2;
  room(20);
  text("Gross pay", W - M - 110, y, { font: bold, right: true }); text(money(p.totals.gross), W - M - 4, y, { font: bold, right: true }); y -= 20;

  head("DEDUCTIONS");
  row("PAYG tax withheld" + (p.totals.stsl ? ` (incl. ${money(p.totals.stsl)} study and training loan)` : ""), null, null, -p.totals.payg);
  if (p.totals.salarySacrifice) row(`Salary sacrifice to super${p.employee.fund ? ` - paid to ${p.employee.fund}` : ""}`, null, null, -p.totals.salarySacrifice);
  for (const l of p.lines.filter(x => x.kind === "deduction")) row(l.description || l.name, null, null, -l.amount, l.payee ? `Paid to ${l.payee}` : undefined);
  for (const l of p.lines.filter(x => x.kind === "reimbursement")) row(`${l.description || l.name} (reimbursement, not taxed)`, null, null, l.amount);
  y -= 6;
  room(46);
  page.drawRectangle({ x: W - M - 240, y: y - 6, width: 240, height: 22, color: band });
  text("NET PAY", W - M - 230, y, { size: 11, font: bold }); text(money(p.totals.net), W - M - 8, y, { size: 12, font: bold, right: true });
  y -= 22;
  if (p.employee.bank) { text(`Paid into account ending ${p.employee.bank.replace(/\D/g, "")}`, W - M - 4, y, { size: 8, color: grey, right: true }); y -= 12; }
  y -= 12;

  // Super.
  room(47);
  text("SUPERANNUATION", M, y, { size: 7, font: bold, color: grey }); y -= 13;
  text(`Super guarantee (employer): ${money(p.totals.superGuarantee)}${p.totals.salarySacrifice ? `   Salary sacrifice: ${money(p.totals.salarySacrifice)}` : ""}`, M, y); y -= 12;
  text(`Fund: ${p.employee.fund || "not recorded"}${p.employee.fundUsi ? ` (USI ${p.employee.fundUsi})` : ""}${p.employee.member ? `   Member no. ${p.employee.member}` : ""}`, M, y); y -= 22;

  // Year to date and leave.
  if (p.ytd) {
    room(35);
    text("YEAR TO DATE (this financial year)", M, y, { size: 7, font: bold, color: grey }); y -= 13;
    text(`Gross ${money(p.ytd.gross)}    Tax ${money(p.ytd.payg)}    Super ${money(p.ytd.super)}    Net ${money(p.ytd.net)}`, M, y); y -= 22;
  }
  if (p.leave?.length) {
    room(35);
    text("LEAVE BALANCES (hours, end of period)", M, y, { size: 7, font: bold, color: grey }); y -= 13;
    text(p.leave.map(l => `${l.type}: ${Number(l.balance).toLocaleString("en-AU", { maximumFractionDigits: 2 })}`).join("    "), M, y); y -= 22;
  }
  const pages = pdf.getPages();
  pages.forEach((pg: any, i: number) => {
    page = pg;
    text(`${p.employer.legalName}${p.employer.abn ? ` - ABN ${fmtAbn(p.employer.abn)}` : ""} - Payslip issued for pay run ${p.payRun.number}. Keep it for your records.`
      + (pages.length > 1 ? `  Page ${i + 1} of ${pages.length}` : ""), M, 24, { size: 7, color: grey });
  });
  return await pdf.save();
}
