/** A small, dependency-free PDF writer for the provisional theory certificate. */
import { FONT_METRICS } from "./certificate-font-metrics.mjs";
const encoder = new TextEncoder();

function bytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function pdfString(value) {
  return String(value).normalize("NFC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?")
    .replace(/[\\()]/g, "\\$&")
    .replace(/[\xa0-\xff]/g, character => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`);
}

function text(value, x, y, size, bold = false, color = "0.04 0.16 0.28") {
  return `${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfString(value)}) Tj ET\n`;
}

function rect(x, y, width, height, color) {
  return `${color} rg ${x} ${y} ${width} ${height} re f\n`;
}

function line(x1, y1, x2, y2, color, width = 1) {
  return `${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
}

function displayName(value) {
  const name = String(value).trim().replace(/\s+/g, " ");
  if (!name || name.length > 70) throw new Error("Enter a learner name of 1 to 70 characters.");
  return name;
}

function textWidth(value, size, bold = false) {
  const widths = FONT_METRICS[bold ? "bold" : "regular"].widths;
  return [...String(value)].reduce((sum, character) => {
    const code = character.charCodeAt(0);
    return sum + (widths[code - 32] || widths[31]) * size / 1000;
  }, 0);
}

function dateTaken(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) throw new Error("The assessment date is invalid.");
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "Australia/Melbourne", timeZoneName: "short"
  }).format(date);
}

/** Return a downloadable, one-page landscape A4 PDF. The caller supplies the company logo as JPEG bytes. */
export function createTheoryCertificatePdf({ learnerName, employeeId = "", moduleCode, moduleTitle,
  score, correct, total, criticalCorrect, criticalTotal, attempt, submittedAt,
  logoJpeg, regularFont, boldFont }) {
  if (!(logoJpeg instanceof Uint8Array) || logoJpeg[0] !== 0xff || logoJpeg[1] !== 0xd8) {
    throw new Error("The Panalo Pipes logo could not be loaded.");
  }
  if (![regularFont, boldFont].every(font => font instanceof Uint8Array && font[0] === 0 && font[1] === 1)) {
    throw new Error("The certificate fonts could not be loaded.");
  }
  const name = displayName(learnerName);
  if (!Number.isInteger(correct) || !Number.isInteger(total) || total < 1 || correct < 0 || correct > total ||
      !Number.isInteger(score) || score !== Math.round(correct / total * 100) ||
      !Number.isInteger(criticalCorrect) || !Number.isInteger(criticalTotal) || criticalCorrect !== criticalTotal ||
      score < 80) throw new Error("Only a passing theory result can receive a certificate.");

  const date = dateTaken(submittedAt);
  const navy = "0.035 0.16 0.29";
  const gold = "0.95 0.73 0.12";
  const slate = "0.24 0.31 0.39";
  let content = rect(0, 0, 842, 595, "1 1 1");
  content += rect(0, 0, 842, 15, navy) + rect(0, 580, 842, 15, navy);
  content += rect(20, 20, 802, 4, gold) + rect(20, 571, 802, 4, gold);
  content += "q 245 0 0 85 298 474 cm /Im1 Do Q\n";
  const title = "CERTIFICATE OF THEORY COMPLETION";
  content += text(title, Math.round((842 - textWidth(title, 26, true)) / 2), 443, 26, true, navy);
  content += line(168, 427, 674, 427, gold, 3);
  content += text("This provisional certificate records the online theory result for", 206, 399, 13, false, slate);
  let nameSize = 29;
  while (textWidth(name, nameSize, true) > 650 && nameSize > 10) nameSize--;
  if (textWidth(name, nameSize, true) > 650) throw new Error("The learner name is too wide for the certificate. Please shorten it.");
  const nameX = Math.max(75, Math.round((842 - textWidth(name, nameSize, true)) / 2));
  content += text(name, nameX, 353, nameSize, true, navy);
  content += line(155, 339, 687, 339, "0.72 0.77 0.82", 1);
  const courseSize = textWidth(moduleTitle, 18, true) > 680 ? 15 : 18;
  content += text(moduleTitle, Math.max(70, Math.round((842 - textWidth(moduleTitle, courseSize, true)) / 2)), 310, courseSize, true, navy);
  content += text(`Module ${moduleCode}`, 347, 287, 11, false, slate);

  content += rect(92, 194, 206, 70, "0.94 0.96 0.98");
  content += rect(318, 194, 206, 70, "0.94 0.96 0.98");
  content += rect(544, 194, 206, 70, "0.94 0.96 0.98");
  content += text("ASSESSMENT SCORE", 113, 240, 10, true, slate);
  content += text(`${correct} / ${total} (${score}%)`, 113, 211, 18, true, navy);
  content += text("CRITICAL QUESTIONS", 339, 240, 10, true, slate);
  content += text(`${criticalCorrect} / ${criticalTotal} passed`, 339, 211, 17, true, navy);
  content += text("ATTEMPT", 565, 240, 10, true, slate);
  content += text(String(attempt), 565, 211, 18, true, navy);

  content += text("Date taken (Melbourne time):", 92, 166, 11, true, slate);
  content += text(date, 304, 166, 11, false, navy);
  const id = String(employeeId).trim();
  if (id) content += text(`Employee ID: ${id.slice(0, 40)}`, 92, 144, 10, false, slate);
  content += rect(92, 93, 658, 34, "0.99 0.94 0.78");
  content += text("PRACTICAL VERIFICATION AND SITE AUTHORISATION PENDING", 145, 105, 12, true, navy);
  content += text("This is an online theory result. It does not authorise independent hot work.", 188, 68, 11, false, slate);
  content += text("Generated on the learner's device. Name and result are unverified; retain the record under the Panalo Pipes IMS process.", 113, 47, 8.6, false, slate);

  const stream = bytes(content);
  const objects = [
    bytes("<< /Type /Catalog /Pages 2 0 R >>"),
    bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    bytes("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 7 0 R >>"),
    bytes(`<< /Type /Font /Subtype /TrueType /BaseFont /DejaVuSans /FirstChar 32 /LastChar 255 /Widths [${FONT_METRICS.regular.widths.join(" ")}] /FontDescriptor 8 0 R /Encoding /WinAnsiEncoding >>`),
    bytes(`<< /Type /Font /Subtype /TrueType /BaseFont /DejaVuSans-Bold /FirstChar 32 /LastChar 255 /Widths [${FONT_METRICS.bold.widths.join(" ")}] /FontDescriptor 9 0 R /Encoding /WinAnsiEncoding >>`),
    [bytes(`<< /Type /XObject /Subtype /Image /Width 330 /Height 115 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoJpeg.length} >>\nstream\n`), logoJpeg, bytes("\nendstream")],
    [bytes(`<< /Length ${stream.length} >>\nstream\n`), stream, bytes("endstream")],
    bytes(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${FONT_METRICS.regular.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${FONT_METRICS.regular.ascent} /Descent ${FONT_METRICS.regular.descent} /CapHeight 730 /StemV 80 /FontFile2 10 0 R >>`),
    bytes(`<< /Type /FontDescriptor /FontName /DejaVuSans-Bold /Flags 32 /FontBBox [${FONT_METRICS.bold.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${FONT_METRICS.bold.ascent} /Descent ${FONT_METRICS.bold.descent} /CapHeight 730 /StemV 120 /FontFile2 11 0 R >>`),
    [bytes(`<< /Length ${regularFont.length} /Length1 ${regularFont.length} >>\nstream\n`), regularFont, bytes("\nendstream")],
    [bytes(`<< /Length ${boldFont.length} /Length1 ${boldFont.length} >>\nstream\n`), boldFont, bytes("\nendstream")]
  ];
  const chunks = [];
  const offsets = [0];
  let length = 0;
  function add(part) { const item = bytes(part); chunks.push(item); length += item.length; }
  add("%PDF-1.4\n%Panalo Pipes\n");
  objects.forEach((object, index) => {
    offsets.push(length);
    add(`${index + 1} 0 obj\n`);
    for (const part of Array.isArray(object) ? object : [object]) add(part);
    add("\nendobj\n");
  });
  const xref = length;
  add(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach(offset => add(`${String(offset).padStart(10, "0")} 00000 n \n`));
  add(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const pdf = new Uint8Array(length);
  let cursor = 0;
  chunks.forEach(chunk => { pdf.set(chunk, cursor); cursor += chunk.length; });
  return pdf;
}
