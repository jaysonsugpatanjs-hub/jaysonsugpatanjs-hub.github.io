// A plain A4 record of typed onboarding answers, filed in the person's HR
// folder when HR accepts the item.
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export type RecordInput = {
  title: string;
  personName: string;
  employeeNumber: string;
  submittedAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  rows: { label: string; value: string }[];
  note?: string;
};

const latin = (v: string) => String(v ?? "").replace(/[^\x20-\x7E -ÿ]/g, "-");
const when = (iso: string | null) => iso
  ? new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Sydney" }).format(new Date(iso))
  : "—";

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

export async function createRecordPdf(input: RecordInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin(`${input.title} - ${input.personName}`));
  pdf.setAuthor("Panalo Pipes & Structurals Pty Ltd");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.08, 0.09);
  const grey = rgb(0.38, 0.38, 0.42);
  const gold = rgb(0.96, 0.72, 0.0);
  const [W, H, M] = [595.28, 841.89, 48];
  let page = pdf.addPage([W, H]);
  let y = H - M;

  const header = () => {
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: gold });
    page.drawText("PANALO PIPES & STRUCTURALS PTY LTD - PERSONNEL RECORD", { x: M, y: H - 30, size: 8, font: bold, color: grey });
    y = H - 60;
  };
  const ensure = (needed: number) => {
    if (y - needed < M + 30) { page = pdf.addPage([W, H]); header(); }
  };
  header();

  page.drawText(latin(input.title), { x: M, y, size: 18, font: bold, color: ink });
  y -= 26;
  const facts = [
    ["Person", `${input.personName}${input.employeeNumber ? ` (${input.employeeNumber})` : ""}`],
    ["Submitted on the portal", when(input.submittedAt)],
    ["Accepted by HR", `${when(input.acceptedAt)}${input.acceptedBy ? ` - ${input.acceptedBy}` : ""}`]
  ];
  for (const [k, v] of facts) {
    page.drawText(latin(k), { x: M, y, size: 9, font: regular, color: grey });
    page.drawText(latin(v), { x: M + 140, y, size: 9, font: bold, color: ink });
    y -= 14;
  }
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: grey });
  y -= 20;

  const labelW = 190, valueX = M + labelW + 12, valueW = W - M - valueX;
  for (const row of input.rows) {
    const labelLines = wrap(row.label, regular, 10, labelW);
    const valueLines = wrap(row.value, bold, 10, valueW);
    const lines = Math.max(labelLines.length, valueLines.length);
    ensure(lines * 13 + 8);
    labelLines.forEach((l, i) => page.drawText(l, { x: M, y: y - i * 13, size: 10, font: regular, color: grey }));
    valueLines.forEach((l, i) => page.drawText(l, { x: valueX, y: y - i * 13, size: 10, font: bold, color: ink }));
    y -= lines * 13 + 8;
  }

  ensure(60);
  y -= 10;
  for (const l of wrap(input.note || "Typed and declared by the person on the Panalo portal after signing in with their own account. Generated automatically from the submitted answers; the original submission and its audit trail are kept in the system.", regular, 8, W - 2 * M)) {
    page.drawText(l, { x: M, y, size: 8, font: regular, color: grey });
    y -= 11;
  }
  const pages = pdf.getPages();
  pages.forEach((p: any, i: number) => p.drawText(`Page ${i + 1} of ${pages.length} - Confidential personnel record`, { x: M, y: 24, size: 7, font: regular, color: grey }));
  return await pdf.save();
}
