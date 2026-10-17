// The signed copy of an employment contract: the exact contract pages the
// person was shown, followed by a signature record (who, how, when, what they
// agreed to, and the SHA-256 of each contract file). Filed in their HR folder
// when HR accepts the signature.
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { createRecordPdf, type RecordInput } from "./record-pdf.ts";

export const SIGNED_NOTE =
  "Electronically signed on the Panalo portal after signing in with the person's own account. The contract pages before this record are the exact files the person was shown; the SHA-256 fingerprints above identify them. The original files and the audit trail are kept in the system.";

export async function createSignedContractPdf(input: { contracts: Uint8Array[]; record: RecordInput }) {
  const recordBytes = await createRecordPdf({ ...input.record, note: input.record.note ?? SIGNED_NOTE, footer: input.record.footer ?? "Electronic signature record" });
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
  const record = await PDFDocument.load(recordBytes);
  const recordPages = await out.copyPages(record, record.getPageIndices());
  recordPages.forEach((page: unknown) => out.addPage(page as never));
  out.setTitle(`${input.record.title} - ${input.record.personName} (signed)`.replace(/[^\x20-\x7E]/g, "-"));
  out.setAuthor("Panalo Pipes & Structurals Pty Ltd");
  return { bytes: await out.save(), contractsIncluded: included };
}
