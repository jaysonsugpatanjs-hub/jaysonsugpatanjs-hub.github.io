// The signed copy of an employment contract: the exact contract pages the
// person was shown, with their signature and the date placed on the signature
// lines HR chose, followed by a signature record (who, how, when, what they
// agreed to, and the SHA-256 of each contract file). Filed in their HR folder
// when HR finalizes the signature.
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { latin, createRecordPdf, type RecordInput } from "./record-pdf.ts";
import { pdfPoint, resolvePage, type PagePoint, type Placement } from "./contract-signing.ts";
import { inkOnTransparent } from "./png-ink.ts";

export const SIGNED_NOTE =
  "Electronically signed on the Panalo portal after signing in with the person's own account. The contract pages before this record are the exact files the person was shown, with the signature and date placed on them; the SHA-256 fingerprints above identify the original files. The original files and the audit trail are kept in the system.";

/** For contracts with Word files, which are filed unchanged beside this record. */
export const SIGNED_WORD_NOTE =
  "Electronically signed on the Panalo portal after signing in with the person's own account. The contract was attached as a Word document, which is filed unchanged beside this record; the SHA-256 fingerprints above identify the exact files the person was shown. The original files and the audit trail are kept in the system.";
export const SIGNED_MIXED_NOTE =
  "Electronically signed on the Panalo portal after signing in with the person's own account. The PDF contract pages before this record have the signature and date placed on them; the Word files are filed unchanged beside this record. The SHA-256 fingerprints above identify the exact files the person was shown. The original files and the audit trail are kept in the system.";

export type Stamp = {
  placement: Placement;
  signedName: string;
  method: string;
  /** When they signed (ISO). */
  signedAt: string | null;
  /** The handwritten signature (PNG), when they wrote it. */
  image?: Uint8Array;
  /** Panalo's counter-signature, on the same page. */
  company?: { name: string; method: string; image?: Uint8Array; signature: PagePoint; date: PagePoint | null; signedAt: string | null };
};

const SIGN_W = 130; // widest signature, in points
const SIGN_H = 40;

const signedDate = (iso: string | null) => iso
  ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" }).format(new Date(iso))
  : "";

/** One signature on a signature line: the handwriting, or the typed name in script. */
async function drawSignature(out: any, page: any, p: PagePoint, who: { name: string; method: string; image?: Uint8Array }) {
  const at = pdfPoint(page.getWidth(), page.getHeight(), p);
  if (who.method === "drawn" && who.image) {
    try {
      // Ink only, so the signature never blanks out the text around the line.
      const image = await out.embedPng(await inkOnTransparent(who.image));
      const scale = Math.min(SIGN_W / image.width, SIGN_H / image.height);
      page.drawImage(image, { x: at.x + 2, y: at.y + 3, width: image.width * scale, height: image.height * scale });
      return;
    } catch (error) {
      // An unreadable image falls back to the typed name; the stored image is kept.
      console.error("signature image could not be embedded", error);
    }
  }
  const font = await out.embedFont(StandardFonts.TimesRomanItalic);
  const name = latin(who.name);
  let size = 20;
  while (size > 9 && font.widthOfTextAtSize(name, size) > SIGN_W) size -= 1;
  page.drawText(name, { x: at.x + 2, y: at.y + 5, size, font, color: rgb(0.05, 0.08, 0.35) });
}

async function drawDate(out: any, page: any, p: PagePoint, iso: string | null) {
  const when = signedDate(iso);
  if (!when) return;
  const font = await out.embedFont(StandardFonts.Helvetica);
  const at = pdfPoint(page.getWidth(), page.getHeight(), p);
  page.drawText(when, { x: at.x + 2, y: at.y + 3, size: 10, font, color: rgb(0.05, 0.08, 0.35) });
}

async function stampPage(out: any, stamp: Stamp, pageCount: number) {
  const page = out.getPages()[resolvePage(stamp.placement, pageCount)];
  await drawSignature(out, page, stamp.placement.signature, { name: stamp.signedName, method: stamp.method, image: stamp.image });
  if (stamp.placement.date) await drawDate(out, page, stamp.placement.date, stamp.signedAt);
  const c = stamp.company;
  if (c) {
    await drawSignature(out, page, c.signature, { name: c.name, method: c.method, image: c.image });
    if (c.date) await drawDate(out, page, c.date, c.signedAt);
  }
}

export async function createSignedContractPdf(input: { contracts: Uint8Array[]; record: RecordInput; stamp?: Stamp; preview?: boolean }) {
  const recordBytes = await createRecordPdf({
    ...input.record, note: input.record.note ?? SIGNED_NOTE,
    footer: input.record.footer ?? (input.preview ? "PREVIEW - not finalized yet" : "Electronic signature record")
  });
  const out = await PDFDocument.create();
  let included = 0;
  for (const bytes of input.contracts) {
    try {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await out.copyPages(source, source.getPageIndices());
      pages.forEach((page: unknown) => out.addPage(page as never));
      included++;
    } catch (error) {
      // Encrypted or damaged PDFs can't be merged. The original is still
      // stored, and the record lists its fingerprint, so nothing is lost.
      console.error("contract PDF could not be merged", error);
    }
  }
  if (!included) return { bytes: recordBytes, contractsIncluded: 0 };
  if (input.stamp) await stampPage(out, input.stamp, out.getPageCount());
  const record = await PDFDocument.load(recordBytes);
  const recordPages = await out.copyPages(record, record.getPageIndices());
  recordPages.forEach((page: unknown) => out.addPage(page as never));
  out.setTitle(`${input.record.title} - ${input.record.personName} (signed)`.replace(/[^\x20-\x7E]/g, "-"));
  out.setAuthor("Panalo Pipes & Structurals Pty Ltd");
  return { bytes: await out.save(), contractsIncluded: included };
}
