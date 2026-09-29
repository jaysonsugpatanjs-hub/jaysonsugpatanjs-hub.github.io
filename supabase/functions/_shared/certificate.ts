import { PDFDocument, StandardFonts, rgb, type PDFFont } from "npm:pdf-lib@1.17.1";

type CertificateInput = {
  learnerName: string;
  externalId?: string | null;
  moduleCode: string;
  moduleTitle: string;
  revision: string;
  score: number;
  correct: number;
  total: number;
  criticalCorrect: number;
  criticalTotal: number;
  attemptNumber: number;
  submittedAt: string;
  certificateNumber: string;
  practicalRequired: boolean;
  logoJpeg?: Uint8Array | null;
};

function safeLatin(value: string) {
  return String(value || "").replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "-");
}

function centered(page: any, text: string, y: number, font: PDFFont, size: number, color = rgb(0.03, 0.18, 0.34)) {
  const clean = safeLatin(text);
  const width = font.widthOfTextAtSize(clean, size);
  page.drawText(clean, { x: (page.getWidth() - width) / 2, y, size, font, color });
}

function wrappedCentered(page: any, text: string, y: number, maxWidth: number, font: PDFFont, size: number, lineHeight: number) {
  const words = safeLatin(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  lines.forEach((value, index) => centered(page, value, y - index * lineHeight, font, size));
  return y - Math.max(0, lines.length - 1) * lineHeight;
}

export async function createCertificatePdf(input: CertificateInput) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([841.89, 595.28]);
  const navy = rgb(0.03, 0.18, 0.34);
  const yellow = rgb(0.95, 0.76, 0.09);
  const grey = rgb(0.29, 0.36, 0.44);
  const pale = rgb(0.94, 0.97, 0.95);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({ x: 18, y: 18, width: 805.89, height: 559.28, borderColor: navy, borderWidth: 3 });
  page.drawRectangle({ x: 25, y: 25, width: 791.89, height: 545.28, borderColor: yellow, borderWidth: 1.5 });
  page.drawRectangle({ x: 39, y: 517, width: 763.89, height: 39, color: navy });

  if (input.logoJpeg) {
    try {
      const logo = await pdf.embedJpg(input.logoJpeg);
      const scale = Math.min(92 / logo.width, 29 / logo.height);
      page.drawImage(logo, { x: 55, y: 522, width: logo.width * scale, height: logo.height * scale });
    } catch (_) {
      page.drawText("PANALO", { x: 56, y: 530, size: 12, font: bold, color: yellow });
    }
  } else {
    page.drawText("PANALO", { x: 56, y: 530, size: 12, font: bold, color: yellow });
  }

  centered(page, "PANALO PIPES & STRUCTURALS PTY LTD", 531, bold, 13, rgb(1, 1, 1));
  centered(page, "CERTIFICATE OF COMPLETION", 470, bold, 24, navy);
  centered(page, "This certifies that", 430, regular, 12, grey);
  centered(page, input.learnerName, 392, bold, 27, navy);
  page.drawLine({ start: { x: 190, y: 382 }, end: { x: 652, y: 382 }, color: yellow, thickness: 2 });
  centered(page, "has successfully completed the training for", 354, regular, 12, grey);
  const afterTitle = wrappedCentered(page, input.moduleTitle, 322, 650, bold, 20, 24);
  const cardY = afterTitle - 72;
  const cardWidth = 154;
  const startX = 96;
  const gap = 18;
  const cards = [
    ["SCORE", `${input.correct}/${input.total} (${input.score}%)`],
    ["CRITICAL", `${input.criticalCorrect}/${input.criticalTotal} PASS`],
    ["ATTEMPT", String(input.attemptNumber)],
    ["DATE TAKEN", new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "Australia/Sydney" }).format(new Date(input.submittedAt))]
  ];
  cards.forEach(([label, value], index) => {
    const x = startX + index * (cardWidth + gap);
    page.drawRectangle({ x, y: cardY, width: cardWidth, height: 53, color: rgb(0.96, 0.97, 0.98), borderColor: rgb(0.83, 0.87, 0.9), borderWidth: 1 });
    const labelWidth = bold.widthOfTextAtSize(label, 8);
    const valueWidth = bold.widthOfTextAtSize(safeLatin(value), 11);
    page.drawText(label, { x: x + (cardWidth - labelWidth) / 2, y: cardY + 34, size: 8, font: bold, color: grey });
    page.drawText(safeLatin(value), { x: x + (cardWidth - valueWidth) / 2, y: cardY + 14, size: 11, font: bold, color: navy });
  });

  page.drawRectangle({ x: 96, y: cardY - 58, width: 670, height: 37, color: pale, borderColor: rgb(0.09, 0.53, 0.29), borderWidth: 1 });
  centered(page, input.practicalRequired
    ? "COMPLETION RECORDED - PRACTICAL VERIFICATION AND SITE AUTHORISATION PENDING"
    : "TRAINING REQUIREMENT COMPLETED", cardY - 44, bold, 11, rgb(0.05, 0.38, 0.2));

  const idText = input.externalId ? `Learner record: ${input.externalId}` : "Learner record: verified email account";
  page.drawText(safeLatin(idText), { x: 55, y: 67, size: 8.5, font: regular, color: grey });
  page.drawText(`Certificate: ${safeLatin(input.certificateNumber)}`, { x: 55, y: 51, size: 8.5, font: bold, color: navy });
  const footer = input.practicalRequired
    ? "This certificate records completion of the assigned training. It is not a licence or practical task authorisation."
    : "This certificate records completion of the assigned training. It is not a trade licence or site authorisation.";
  const footerWidth = regular.widthOfTextAtSize(footer, 8.5);
  page.drawText(footer, { x: 787 - footerWidth, y: 51, size: 8.5, font: regular, color: grey });

  pdf.setTitle(`Certificate of Completion - ${input.learnerName}`);
  pdf.setAuthor("Panalo Pipes & Structurals Pty Ltd");
  pdf.setSubject(input.practicalRequired ? "Training completion - practical verification pending" : "Training completion");
  pdf.setCreationDate(new Date(input.submittedAt));
  return pdf.save();
}
