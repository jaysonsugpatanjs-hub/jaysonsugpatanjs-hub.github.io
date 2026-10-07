// A4 BAS workpaper: the labels to enter on the activity statement, the
// figures behind them by tax code, the PAYG withholding, the reconciliation
// to the GST and PAYG accounts, the exceptions and who prepared, reviewed and
// lodged it. A preparation record: it isn't a lodgement with the ATO.
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export type BasPdfInput = {
  company: { legalName: string; abn?: string | null };
  period: { from: string; to: string; frequency: string; basis: string; method: string; due: string };
  status: string;
  labels: Record<string, number>;
  exact: Record<string, number>;
  codes: { code: string; name: string; labels: string[]; base: number; gst: number; gross: number }[];
  reconciliation: any;
  exceptions: { severity: string; number?: string | null; date?: string | null; message: string; amount?: number | null }[];
  adjustments?: { period: string; labels: { label: string; amount: number }[] }[];
  people: { prepared?: string; reviewed?: string; reviewComment?: string | null; lodged?: string; reference?: string | null };
  notes?: string;
};

const latin = (v: unknown) => String(v ?? "").replace(/[^\x20-\x7E -ÿ]/g, "-");
const money = (n: unknown) => {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${s}` : `$${s}`;
};
const whole = (n: unknown) => {
  const v = Math.trunc(Number(n || 0));
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-AU")}`;
};
const day = (iso?: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
const fmtAbn = (a?: string | null) => (a ? a.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4") : "");

export async function createBasPdf(p: BasPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin(`BAS workpaper ${p.period.from} to ${p.period.to}`));
  pdf.setAuthor(latin(p.company.legalName));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.08, 0.09), grey = rgb(0.4, 0.4, 0.44), line = rgb(0.82, 0.82, 0.85), gold = rgb(0.96, 0.72, 0.0), band = rgb(0.96, 0.96, 0.97);
  const [W, H, M] = [595.28, 841.89, 42];
  let page = pdf.addPage([W, H]);
  let y = H - 40;
  const text = (t: string, x: number, yy: number, o: { size?: number; font?: any; color?: any; right?: boolean } = {}) => {
    const size = o.size ?? 9, font = o.font ?? regular;
    let s = latin(t);
    const max = W - M - x + (o.right ? x - M : 0);
    while (s.length > 4 && font.widthOfTextAtSize(s, size) > max) s = s.slice(0, -2);
    page.drawText(s, { x: o.right ? x - font.widthOfTextAtSize(s, size) : x, y: yy, size, font, color: o.color ?? ink });
  };
  const room = (h: number) => {
    if (y - h >= 48) return;
    page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: gold });
    y = H - 40;
  };
  const heading = (t: string) => {
    room(40);
    y -= 8;
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: band });
    text(t, M + 4, y, { size: 8, font: bold, color: grey });
    y -= 20;
  };
  const row = (label: string, value: string, o: { bold?: boolean; sub?: string } = {}) => {
    room(o.sub ? 24 : 13);
    text(label, M + 4, y, { font: o.bold ? bold : regular });
    text(value, W - M - 4, y, { right: true, font: o.bold ? bold : regular });
    y -= 12;
    if (o.sub) { text(o.sub, M + 14, y, { size: 7.5, color: grey }); y -= 11; }
    page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.4, color: line });
  };

  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: gold });
  text(p.company.legalName, M, y, { size: 13, font: bold });
  text("BAS WORKPAPER", W - M, y, { size: 16, font: bold, right: true });
  y -= 15;
  if (p.company.abn) { text(`ABN ${fmtAbn(p.company.abn)}`, M, y, { size: 8, color: grey }); }
  text(`${day(p.period.from)} to ${day(p.period.to)}`, W - M, y, { size: 10, font: bold, right: true });
  y -= 13;
  text(`${p.period.frequency} · GST ${p.period.basis} basis · ${p.period.method === "full" ? "full reporting (G1 to G20)" : "simpler BAS (G1, 1A, 1B)"} · due ${day(p.period.due)} · ${p.status}`,
    W - M, y, { size: 8, color: grey, right: true });
  y -= 8;

  const L = p.labels;
  heading("GOODS AND SERVICES TAX (whole dollars, as entered on the BAS)");
  const gLabels = p.period.method === "full"
    ? [["G1", "Total sales (including any GST)"], ["G2", "Export sales"], ["G3", "Other GST-free sales"], ["G4", "Input taxed sales"], ["G10", "Capital purchases (including any GST)"],
       ["G11", "Non-capital purchases (including any GST)"], ["G13", "Purchases for making input taxed sales"], ["G14", "Purchases without GST in the price"], ["G15", "Estimated purchases for private use or not income tax deductible"]]
    : [["G1", "Total sales (including any GST)"]];
  for (const [k, n] of gLabels) row(`${k}  ${n}`, whole(L[k]));
  row("1A  GST on sales", whole(L["1A"]), { bold: true });
  row("1B  GST on purchases", whole(L["1B"]), { bold: true });

  heading("PAYG TAX WITHHELD");
  row("W1  Total salary, wages and other payments", whole(L.W1));
  row("W2  Amounts withheld from payments shown at W1", whole(L.W2));
  row("W4  Amounts withheld where no ABN is quoted", whole(L.W4));
  row("W3  Other amounts withheld", whole(L.W3));
  row("W5  Total amounts withheld (W2 + W4 + W3)", whole(L.W5), { bold: true });

  heading("SUMMARY");
  row("1A  GST on sales", whole(L["1A"]));
  row("4   PAYG tax withheld", whole(L["4"]));
  row("5A  PAYG income tax instalment", whole(L["5A"]));
  row("8A  Amount owed to the ATO", whole(L["8A"]), { bold: true });
  row("1B  GST on purchases", whole(L["1B"]));
  row("7D  Fuel tax credit", whole(L["7D"]));
  row("8B  Amount the ATO owes", whole(L["8B"]), { bold: true });
  row(Number(L["9"]) >= 0 ? "9   Payment due to the ATO" : "9   Refund due from the ATO", whole(Math.abs(Number(L["9"]))), { bold: true });

  heading("GST BY TAX CODE (exact amounts)");
  for (const c of p.codes) row(`${c.code}  ${c.name}  [${c.labels.join(", ")}]`, `${money(c.base)} + GST ${money(c.gst)} = ${money(c.gross)}`);
  if (!p.codes.length) row("No GST-coded amounts in the period", "");
  row("1A exact / 1B exact", `${money(p.exact["1A"])} / ${money(p.exact["1B"])}`);
  if (p.period.method === "full") {
    row("Worksheet G9 (G8 / 11) and G20 (G19 / 11)", `${money(p.exact.G9)} / ${money(p.exact.G20)}`,
      { sub: "Should be close to 1A and 1B. They differ where GST-free or input-taxed items are coded with GST, or GST was rounded per line." });
  }

  if (p.adjustments?.length) {
    heading("ADJUSTMENTS FROM EARLIER BAS (included above)");
    for (const a of p.adjustments) row(`Changes to ${a.period} after it was lodged`, a.labels.map(l => `${l.label} ${money(l.amount)}`).join("  "));
  }

  const r = p.reconciliation || {};
  heading("RECONCILIATION TO THE LEDGER");
  if (r.gst) {
    row("GST account movement in the period (excluding BAS transfers)", money(r.gst.accountMovement));
    row(r.gst.accrualExpected != null ? "1A less 1B on the accrual basis" : "1A less 1B", money(r.gst.accrualExpected ?? r.gst.expected));
    row("Difference", money(r.gst.difference), { bold: true, sub: Number(r.gst.notFromTaxLines) ? `Of which posted straight to the GST account: ${money(r.gst.notFromTaxLines)}` : undefined });
    if (r.gst.accrualExpected != null) row("1A less 1B on the cash basis (this BAS)", money(r.gst.expected), { sub: "The rest stays in the GST account until the invoices and bills are paid." });
  }
  if (r.payg) {
    row("PAYG withholding posted by pay runs / W2", `${money(r.payg.payRuns)} / ${money(r.payg.w2)}`);
    row("No-ABN withholding posted on bills / W4", `${money(r.payg.bills)} / ${money(r.payg.w4)}`);
    if (Number(r.payg.other)) row("Other entries to PAYG withholding", money(r.payg.other));
  }

  heading(`EXCEPTIONS TO CHECK (${p.exceptions.length})`);
  for (const e of p.exceptions.slice(0, 60)) {
    room(24);
    text(`${e.severity === "warn" ? "!" : "-"} ${e.number ? `${e.number} ` : ""}${e.date ? day(e.date) : ""}`, M + 4, y, { font: bold, size: 8 });
    if (e.amount != null) text(money(e.amount), W - M - 4, y, { right: true, size: 8 });
    y -= 11;
    text(e.message, M + 14, y, { size: 7.5, color: grey });
    y -= 12;
  }
  if (p.exceptions.length > 60) { text(`and ${p.exceptions.length - 60} more`, M + 4, y, { size: 8, color: grey }); y -= 12; }
  if (!p.exceptions.length) row("None found", "");

  heading("SIGN-OFF");
  row("Prepared", p.people.prepared || "");
  row("Reviewed", p.people.reviewed || "Not yet", { sub: p.people.reviewComment || undefined });
  row("Lodged", p.people.lodged || "Not yet", { sub: p.people.reference ? `ATO reference ${p.people.reference}` : undefined });
  if (p.notes) row("Notes", "", { sub: p.notes.slice(0, 200) });

  const pages = pdf.getPages();
  pages.forEach((pg: any, i: number) => {
    page = pg;
    text(`${p.company.legalName} · BAS workpaper ${day(p.period.from)} to ${day(p.period.to)} · prepared in Panalo Accounts; not lodged with the ATO by this system`
      + (pages.length > 1 ? ` · page ${i + 1} of ${pages.length}` : ""), M, 24, { size: 7, color: grey });
  });
  return await pdf.save();
}
