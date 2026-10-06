// A4 PDFs for Panalo Accounts: tax invoices, adjustment notes (credit notes),
// quotes, purchase orders and customer statements.
//
// A tax invoice shows what the ATO lists for one: the words "Tax invoice",
// the seller's identity and ABN, the issue date, a description, quantity and
// price of each item, the GST payable, and the extent each item is taxable.
// For $1,000 or more (incl. GST) it also shows the buyer's identity or ABN.
// https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export type Party = { name: string; abn?: string | null; address?: any; email?: string | null; phone?: string | null; contact?: string | null };
export type PdfLine = { description: string; quantity: number; unit?: string; unitPrice: number; discountPercent: number; amount: number; gst: number; taxCode?: string | null; taxRate?: number };
export type DocKind = "invoice" | "credit_note" | "quote" | "purchase_order";
export type DocInput = {
  kind: DocKind;
  gstRegistered: boolean;
  seller: Party & { legalName: string; tradingName?: string | null; acn?: string | null; website?: string | null };
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
  to: Party;
  toLabel?: string;
  number: string;
  date: string;
  dueDate?: string | null;
  expiryDate?: string | null;
  reference?: string | null;
  originalNumber?: string | null;
  title?: string | null;
  scope?: string | null;
  deliverTo?: string | null;
  amountsAre: "exclusive" | "inclusive" | "no_tax";
  lines: PdfLine[];
  subtotal: number;
  gst: number;
  total: number;
  paid?: number;
  balance?: number | null;
  bank?: { accountName: string; bsb: string; accountNumber: string } | null;
  notes?: string | null;
  terms?: string | null;
  status?: string | null;
};
export type StatementInput = {
  seller: DocInput["seller"]; logo?: DocInput["logo"]; customer: Party; from: string; to: string;
  openingBalance: number; closingBalance: number;
  rows: { date: string; reference: string; type: string; amount: number }[];
  openInvoices: { number: string; date: string; dueDate: string; total: number; owing: number }[];
  ageing?: { current: number; days30: number; days60: number; days90: number; over90: number } | null;
  bank?: DocInput["bank"];
};

const latin = (v: unknown) => String(v ?? "").replace(/[^\x20-\x7E -ÿ]/g, "-");
const money = (n: number) => {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${s}` : `$${s}`;
};
const qty = (n: number) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: 3 });
const day = (iso?: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
const fmtAbn = (a?: string | null) => a ? a.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4") : "";
const fmtBsb = (b: string) => b.replace(/\D/g, "").replace(/^(\d{3})(\d{3})$/, "$1-$2");
export function addressLines(a: any): string[] {
  if (!a || typeof a !== "object") return [];
  const street = [a.street, a.street2].filter(Boolean).join(", ");
  const town = [a.suburb, a.state, a.postcode].filter(Boolean).join(" ");
  return [street, town].filter(Boolean);
}

function wrap(text: string, font: any, size: number, width: number) {
  const out: string[] = [];
  for (const para of latin(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const TITLES: Record<DocKind, string> = { invoice: "Tax invoice", credit_note: "Adjustment note", quote: "Quote", purchase_order: "Purchase order" };

async function start(seller: DocInput["seller"], logo: DocInput["logo"], title: string) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin(title));
  pdf.setAuthor(latin(seller.legalName));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let image: any = null;
  if (logo?.bytes?.length) {
    try { image = logo.type === "png" ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes); } catch { image = null; }
  }
  return { pdf, regular, bold, image };
}

const C = { ink: rgb(0.08, 0.08, 0.09), grey: rgb(0.4, 0.4, 0.44), line: rgb(0.82, 0.82, 0.85), gold: rgb(0.96, 0.72, 0.0), band: rgb(0.96, 0.96, 0.97) };
const [W, H, M] = [595.28, 841.89, 42];

/** Draws the letterhead; returns the y below it. */
function letterhead(page: any, f: any, seller: DocInput["seller"], image: any, title: string, gstRegistered: boolean) {
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: C.gold });
  let y = H - 36;
  let textX = M;
  if (image) {
    const s = image.scale(1);
    const ratio = Math.min(110 / s.width, 46 / s.height);
    page.drawImage(image, { x: M, y: y + 10 - s.height * ratio, width: s.width * ratio, height: s.height * ratio });
    textX = M + s.width * ratio + 12;
  }
  page.drawText(latin(seller.tradingName || seller.legalName), { x: textX, y, size: 13, font: f.bold, color: C.ink });
  const details = [
    seller.tradingName && seller.tradingName !== seller.legalName ? seller.legalName : "",
    seller.abn ? `ABN ${fmtAbn(seller.abn)}${seller.acn ? `  ·  ACN ${seller.acn.replace(/\D/g, "").replace(/^(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3")}` : ""}` : "",
    ...addressLines(seller.address),
    [seller.phone, seller.email].filter(Boolean).join("  ·  ")
  ].filter(Boolean);
  details.forEach((d, i) => page.drawText(latin(d).replace("·", "-"), { x: textX, y: y - 14 - i * 11, size: 8, font: f.regular, color: C.grey }));
  const heading = latin(title).toUpperCase();
  page.drawText(heading, { x: W - M - f.bold.widthOfTextAtSize(heading, 18), y: y - 4, size: 18, font: f.bold, color: C.ink });
  if (!gstRegistered && title === "Tax invoice") {
    const note = "Not registered for GST";
    page.drawText(note, { x: W - M - f.regular.widthOfTextAtSize(note, 8), y: y - 18, size: 8, font: f.regular, color: C.grey });
  }
  return y - 14 - details.length * 11 - 16;
}

function footer(pdf: any, f: any, text: string) {
  const pages = pdf.getPages();
  pages.forEach((p: any, i: number) => {
    p.drawText(latin(`${text}  -  Page ${i + 1} of ${pages.length}`), { x: M, y: 22, size: 7, font: f.regular, color: C.grey });
  });
}

export async function createFinanceDocumentPdf(d: DocInput): Promise<Uint8Array> {
  // An entity that isn't registered for GST issues an invoice, not a tax invoice.
  const title = d.kind === "invoice" && !d.gstRegistered ? "Invoice" : TITLES[d.kind];
  const f = await start(d.seller, d.logo, `${title} ${d.number}`);
  const { pdf, regular, bold } = f;
  let page = pdf.addPage([W, H]);
  let y = letterhead(page, f, d.seller, f.image, title, d.gstRegistered);

  // Recipient (left) and document facts (right).
  const leftLabel = d.toLabel || (d.kind === "purchase_order" ? "Supplier" : d.kind === "quote" ? "Prepared for" : "Bill to");
  page.drawText(latin(leftLabel).toUpperCase(), { x: M, y, size: 7, font: bold, color: C.grey });
  const toLines = [d.to.name, d.to.contact ? `Attn: ${d.to.contact}` : "", ...addressLines(d.to.address), d.to.abn ? `ABN ${fmtAbn(d.to.abn)}` : "", d.to.email || ""].filter(Boolean);
  toLines.forEach((t, i) => page.drawText(latin(t), { x: M, y: y - 13 - i * 12, size: i === 0 ? 10 : 9, font: i === 0 ? bold : regular, color: C.ink }));
  const facts: [string, string][] = [
    [d.kind === "credit_note" ? "Adjustment note no." : d.kind === "quote" ? "Quote no." : d.kind === "purchase_order" ? "Order no." : "Invoice no.", d.number],
    ["Date", day(d.date)],
    ...(d.dueDate && d.kind === "invoice" ? [["Due", day(d.dueDate)] as [string, string]] : []),
    ...(d.expiryDate ? [["Valid until", day(d.expiryDate)] as [string, string]] : []),
    ...(d.dueDate && d.kind === "purchase_order" ? [["Required by", day(d.dueDate)] as [string, string]] : []),
    ...(d.reference ? [[d.kind === "purchase_order" ? "Job / reference" : "Your reference", d.reference] as [string, string]] : []),
    ...(d.originalNumber ? [["Adjusts invoice", d.originalNumber] as [string, string]] : [])
  ];
  const fx = W - M - 210;
  facts.forEach(([k, v], i) => {
    page.drawText(latin(k), { x: fx, y: y - i * 13, size: 9, font: regular, color: C.grey });
    page.drawText(latin(v), { x: fx + 95, y: y - i * 13, size: 9, font: bold, color: C.ink });
  });
  y -= Math.max(toLines.length * 12 + 13, facts.length * 13) + 14;

  if (d.status && d.status !== "approved") {
    const s = d.status === "void" ? "VOID" : "DRAFT - NOT YET ISSUED";
    page.drawText(s, { x: M, y, size: 11, font: bold, color: rgb(0.75, 0.15, 0.1) });
    y -= 18;
  }
  if (d.title) { page.drawText(latin(d.title), { x: M, y, size: 11, font: bold, color: C.ink }); y -= 16; }
  if (d.deliverTo) {
    page.drawText("DELIVER TO", { x: M, y, size: 7, font: bold, color: C.grey }); y -= 11;
    for (const l of wrap(d.deliverTo, regular, 9, W - 2 * M)) { page.drawText(l, { x: M, y, size: 9, font: regular, color: C.ink }); y -= 11; }
    y -= 6;
  }
  if (d.scope) {
    page.drawText("SCOPE OF WORK", { x: M, y, size: 7, font: bold, color: C.grey }); y -= 11;
    for (const l of wrap(d.scope, regular, 9, W - 2 * M)) {
      if (y < 120) { page = pdf.addPage([W, H]); y = H - 50; }
      page.drawText(l, { x: M, y, size: 9, font: regular, color: C.ink }); y -= 11;
    }
    y -= 8;
  }

  // Lines table.
  const tax = d.amountsAre !== "no_tax";
  const cols = { desc: M + 4, qty: M + 290, price: M + 352, disc: M + 408, gst: M + 446, amount: W - M - 4 };
  const amountLabel = d.amountsAre === "inclusive" ? "Amount inc GST" : tax ? "Amount ex GST" : "Amount";
  const head = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: C.band });
    const r = (t: string, x: number) => page.drawText(t, { x: x - bold.widthOfTextAtSize(t, 8), y, size: 8, font: bold, color: C.grey });
    page.drawText("Description", { x: cols.desc, y, size: 8, font: bold, color: C.grey });
    r("Qty", cols.qty + 30); r("Unit price", cols.price + 44); r("Disc", cols.disc + 26);
    if (tax) r("GST", cols.gst + 40);
    r(amountLabel, cols.amount);
    y -= 18;
  };
  head();
  let untaxed = false;
  for (const l of d.lines) {
    const descLines = wrap(l.description, regular, 9, (cols.qty - 20) - cols.desc);
    const h = descLines.length * 11 + 6;
    if (y - h < 150) { page = pdf.addPage([W, H]); y = H - 50; head(); }
    const free = tax && Number(l.gst) === 0;
    if (free) untaxed = true;
    descLines.forEach((t, i) => page.drawText(t + (i === 0 && free ? " *" : ""), { x: cols.desc, y: y - i * 11, size: 9, font: regular, color: C.ink }));
    const r = (t: string, x: number) => page.drawText(latin(t), { x: x - regular.widthOfTextAtSize(latin(t), 9), y, size: 9, font: regular, color: C.ink });
    r(`${qty(l.quantity)}${l.unit ? ` ${l.unit}` : ""}`, cols.qty + 30);
    r(money(l.unitPrice), cols.price + 44);
    r(l.discountPercent ? `${qty(l.discountPercent)}%` : "", cols.disc + 26);
    if (tax) r(money(l.gst), cols.gst + 40);
    r(money(l.amount), cols.amount);
    y -= h;
    page.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.4, color: C.line });
  }

  // Totals.
  if (y < 190) { page = pdf.addPage([W, H]); y = H - 50; }
  y -= 8;
  const tx = W - M - 220;
  const totals: [string, string, boolean][] = [
    [tax ? "Subtotal (ex GST)" : "Subtotal", money(d.subtotal), false],
    ...(tax ? [[d.kind === "credit_note" ? "GST adjustment" : "GST", money(d.gst), false] as [string, string, boolean]] : []),
    [d.kind === "credit_note" ? "Total credit" : tax ? "Total (inc GST)" : "Total", money(d.total), true],
    ...(d.paid ? [["Paid and credited", money(-d.paid), false] as [string, string, boolean]] : []),
    ...(d.balance != null && d.kind === "invoice" ? [["Balance due", money(d.balance), true] as [string, string, boolean]] : [])
  ];
  for (const [k, v, strong] of totals) {
    const font = strong ? bold : regular;
    page.drawText(latin(k), { x: tx, y, size: strong ? 10 : 9, font, color: C.ink });
    page.drawText(latin(v), { x: W - M - 4 - font.widthOfTextAtSize(latin(v), strong ? 10 : 9), y, size: strong ? 10 : 9, font, color: C.ink });
    y -= strong ? 16 : 13;
  }
  if (untaxed) {
    page.drawText("* No GST applies to this item.", { x: M, y: y + 13, size: 8, font: regular, color: C.grey });
  }
  y -= 10;

  const block = (label: string, text?: string | null) => {
    if (!text) return;
    const lines = wrap(text, regular, 9, W - 2 * M);
    if (y - lines.length * 11 - 14 < 50) { page = pdf.addPage([W, H]); y = H - 50; }
    page.drawText(label.toUpperCase(), { x: M, y, size: 7, font: bold, color: C.grey }); y -= 11;
    for (const l of lines) { page.drawText(l, { x: M, y, size: 9, font: regular, color: C.ink }); y -= 11; }
    y -= 8;
  };
  if (d.kind === "invoice" && d.bank) {
    block("How to pay", `Bank transfer to ${d.bank.accountName}  BSB ${fmtBsb(d.bank.bsb)}  Account ${d.bank.accountNumber}\nPlease use ${d.number} as the payment reference.`);
  }
  if (d.kind === "credit_note") {
    block("About this note", `This adjustment note reduces the amount payable${d.originalNumber ? ` on invoice ${d.originalNumber}` : ""}${tax ? `, including a GST adjustment of ${money(d.gst)}` : ""}.`);
  }
  block("Notes", d.notes);
  block(d.kind === "purchase_order" ? "Conditions" : "Terms", d.terms);
  if (d.kind === "purchase_order") block("Invoicing", `Please quote ${d.number} on your invoice and include your ABN. Invoices without a valid purchase order number may be delayed.`);

  footer(pdf, f, `${d.seller.legalName}${d.seller.abn ? ` - ABN ${fmtAbn(d.seller.abn)}` : ""} - ${title} ${d.number}`);
  return await pdf.save();
}

export async function createStatementPdf(s: StatementInput): Promise<Uint8Array> {
  const f = await start(s.seller, s.logo, `Statement ${s.customer.name}`);
  const { pdf, regular, bold } = f;
  let page = pdf.addPage([W, H]);
  let y = letterhead(page, f, s.seller, f.image, "Statement", true);
  page.drawText("STATEMENT FOR", { x: M, y, size: 7, font: bold, color: C.grey });
  [s.customer.name, ...addressLines(s.customer.address), s.customer.abn ? `ABN ${fmtAbn(s.customer.abn)}` : ""].filter(Boolean)
    .forEach((t, i) => page.drawText(latin(t), { x: M, y: y - 13 - i * 12, size: i ? 9 : 10, font: i ? regular : bold, color: C.ink }));
  const fx = W - M - 210;
  [["Period", `${day(s.from)} to ${day(s.to)}`], ["Amount owing", money(s.closingBalance)]].forEach(([k, v], i) => {
    page.drawText(k, { x: fx, y: y - i * 13, size: 9, font: regular, color: C.grey });
    page.drawText(latin(v), { x: fx + 80, y: y - i * 13, size: 9, font: bold, color: C.ink });
  });
  y -= 70;
  const cols = [M + 4, M + 80, M + 200, W - M - 110, W - M - 4];
  const head = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: C.band });
    page.drawText("Date", { x: cols[0], y, size: 8, font: bold, color: C.grey });
    page.drawText("Reference", { x: cols[1], y, size: 8, font: bold, color: C.grey });
    page.drawText("Details", { x: cols[2], y, size: 8, font: bold, color: C.grey });
    page.drawText("Amount", { x: cols[3] - bold.widthOfTextAtSize("Amount", 8), y, size: 8, font: bold, color: C.grey });
    page.drawText("Balance", { x: cols[4] - bold.widthOfTextAtSize("Balance", 8), y, size: 8, font: bold, color: C.grey });
    y -= 18;
  };
  head();
  let running = s.openingBalance;
  const row = (a: string, b: string, c: string, amt: string, bal: string) => {
    if (y < 120) { page = pdf.addPage([W, H]); y = H - 50; head(); }
    page.drawText(latin(a), { x: cols[0], y, size: 9, font: regular, color: C.ink });
    page.drawText(latin(b), { x: cols[1], y, size: 9, font: regular, color: C.ink });
    page.drawText(latin(c), { x: cols[2], y, size: 9, font: regular, color: C.ink });
    page.drawText(latin(amt), { x: cols[3] - regular.widthOfTextAtSize(latin(amt), 9), y, size: 9, font: regular, color: C.ink });
    page.drawText(latin(bal), { x: cols[4] - regular.widthOfTextAtSize(latin(bal), 9), y, size: 9, font: regular, color: C.ink });
    y -= 14;
  };
  row(day(s.from), "", "Opening balance", "", money(running));
  for (const r of s.rows) {
    running = Math.round((running + Number(r.amount)) * 100) / 100;
    row(day(r.date), r.reference, r.type, money(r.amount), money(running));
  }
  y -= 4;
  page.drawText("Closing balance", { x: cols[2], y, size: 10, font: bold, color: C.ink });
  page.drawText(money(s.closingBalance), { x: cols[4] - bold.widthOfTextAtSize(money(s.closingBalance), 10), y, size: 10, font: bold, color: C.ink });
  y -= 26;
  if (s.ageing) {
    const buckets: [string, number][] = [["Current", s.ageing.current], ["1-30 days", s.ageing.days30], ["31-60 days", s.ageing.days60], ["61-90 days", s.ageing.days90], ["Over 90 days", s.ageing.over90]];
    const bw = (W - 2 * M) / 5;
    buckets.forEach(([k, v], i) => {
      page.drawText(k, { x: M + i * bw + 4, y, size: 8, font: regular, color: C.grey });
      page.drawText(money(v), { x: M + i * bw + 4, y: y - 12, size: 10, font: bold, color: C.ink });
    });
    y -= 34;
  }
  if (s.bank) {
    page.drawText("HOW TO PAY", { x: M, y, size: 7, font: bold, color: C.grey }); y -= 11;
    page.drawText(latin(`Bank transfer to ${s.bank.accountName}  BSB ${fmtBsb(s.bank.bsb)}  Account ${s.bank.accountNumber}. Please quote the invoice numbers.`), { x: M, y, size: 9, font: regular, color: C.ink });
  }
  footer(pdf, f, `${s.seller.legalName} - Statement for ${s.customer.name}`);
  return await pdf.save();
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
