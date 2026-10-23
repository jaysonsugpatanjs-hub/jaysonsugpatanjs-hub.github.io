// Rules for signing the employment contract online. Pure functions only (no
// Deno, network or database), so training/tests can run them under Node.
//
// HR attaches the contract as a PDF or Word file. The applicant ticks that they have read
// and agree, then signs either by typing their full name or by writing it on
// screen. The database (onboarding_record_signature) is the final authority on
// the name check; these helpers give the person a clear message first.

export const SIGN_METHODS = ["typed", "drawn"] as const;
export type SignMethod = typeof SIGN_METHODS[number];

/** The exact wording the applicant agrees to. It is stored with their signature. */
export const AGREEMENT_TEXT =
  "I have read and understood this contract and I agree to be bound by it. I understand that typing or writing my name here is my electronic signature.";

export const CONTRACT_MAX_BYTES = 20 * 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 200_000;

export class SignError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export function normalizeName(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Same comparison as the database: ignore case and spacing, nothing else. */
export function namesMatch(a: unknown, b: unknown): boolean {
  return normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Turns the pad's PNG data URL into bytes, or throws a SignError. */
export function decodeSignatureImage(dataUrl: unknown): Uint8Array {
  const text = typeof dataUrl === "string" ? dataUrl : "";
  if (!text) throw new SignError("signature", "Write your name in the box first.");
  // Check the length before running a pattern over it.
  if (text.length > Math.ceil(SIGNATURE_MAX_BYTES * 1.4) + 40) throw new SignError("signature", "That signature is too large. Clear it and write it again.");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(text);
  if (!match) throw new SignError("signature", "Your signature could not be read. Clear it and write it again.");
  let bytes: Uint8Array;
  try {
    const binary = atob(match[1]);
    bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch {
    throw new SignError("signature", "Your signature could not be read. Clear it and write it again.");
  }
  if (bytes.length < 100 || bytes.length > SIGNATURE_MAX_BYTES || !PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new SignError("signature", "Your signature could not be read. Clear it and write it again.");
  }
  return bytes;
}

export type SignatureRequest = { method: SignMethod; typedName?: string; image?: Uint8Array };

/** Checks what the applicant sent. `registerName` is their name on the HR register. */
export function validateSignature(raw: unknown, registerName: string): SignatureRequest {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (input.agreed !== true) throw new SignError("agreed", "Tick the box to confirm you have read the contract and agree to it.");
  const method = String(input.method ?? "");
  if (!(SIGN_METHODS as readonly string[]).includes(method)) throw new SignError("method", "Choose how you want to sign.");
  if (method === "typed") {
    const typedName = normalizeName(input.name);
    if (!typedName) throw new SignError("name", "Type your full name to sign.");
    if (typedName.length > 120) throw new SignError("name", "That name is too long.");
    if (!namesMatch(typedName, registerName)) throw new SignError("name", `Type your full name exactly as shown: ${normalizeName(registerName)}`);
    return { method: "typed", typedName };
  }
  return { method: "drawn", image: decodeSignatureImage(input.signatureImage) };
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
}

/**
 * Contracts HR can attach. A PDF is stamped with the signature on its page; a
 * Word file is kept exactly as attached, and its fingerprint is recorded with
 * the signature (a Word file has no fixed pages to stamp).
 */
export const CONTRACT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};
export type ContractFormat = "pdf" | "word";

/** Lower-case extension of a contract file name or path, or "" when it isn't one HR can attach. */
export function contractExtension(name: unknown): string {
  const match = /\.([A-Za-z]+)$/.exec(String(name ?? ""));
  const ext = match ? match[1].toLowerCase() : "";
  return CONTRACT_TYPES[ext] ? ext : "";
}

export function contractFormat(name: unknown): ContractFormat {
  return contractExtension(name) === "pdf" ? "pdf" : "word";
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // .docx
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // .doc
const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

/** True when the bytes really are the kind of file the extension says. */
export function contractMatches(bytes: Uint8Array, ext: string): boolean {
  if (ext === "pdf") return looksLikePdf(bytes);
  if (ext === "docx") return startsWith(bytes, ZIP_MAGIC);
  if (ext === "doc") return startsWith(bytes, OLE_MAGIC);
  return false;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh copy: digest() wants an ArrayBuffer-backed view.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

type SignatureAnswers = {
  method?: string; signedName?: string; typedAs?: string; statement?: string;
  documents?: { label?: string; fileName?: string; sha256?: string }[];
};

/**
 * The signature as labelled rows, for HR on screen and for the filed PDF.
 * With `pdf`, fingerprints are split over two lines so they fit the page.
 */
export function describeSignature(answers: Record<string, unknown> | null, opts: { pdf?: boolean } = {}) {
  const a = (answers ?? {}) as SignatureAnswers;
  if (!a.signedName) return [];
  const rows: { key: string; label: string; value: string; sensitive: boolean }[] = [
    { key: "signedName", label: "Signed by", value: a.signedName, sensitive: false },
    {
      key: "method", label: "How they signed", sensitive: false,
      value: a.method === "drawn" ? "Wrote their name on screen" : `Typed their full name${a.typedAs ? ` ("${a.typedAs}")` : ""}`
    }
  ];
  if (a.statement) rows.push({ key: "statement", label: "They agreed to", value: a.statement, sensitive: false });
  for (const [i, d] of (a.documents ?? []).entries()) {
    const sha = String(d.sha256 ?? "");
    rows.push({
      key: `document${i}`, label: `Contract file: ${d.label ?? "Document"}`, sensitive: false,
      value: opts.pdf && sha.length === 64 ? `SHA-256\n${sha.slice(0, 32)}\n${sha.slice(32)}` : `SHA-256 ${sha}`
    });
  }
  return rows;
}

/** Path of the stored handwriting image, if they wrote their signature. */
export function signatureImagePath(answers: Record<string, unknown> | null): string | null {
  const a = (answers ?? {}) as { method?: string; signaturePath?: string };
  return a.method === "drawn" && typeof a.signaturePath === "string" ? a.signaturePath : null;
}

/* ---------------- Where the signature goes on the contract ---------------- */

/** A point on a page, as fractions of its width and height measured from the top-left corner. */
export type PagePoint = { x: number; y: number };
/**
 * HR clicks on the contract page: `signature` is the left end of the signature
 * line, `date` (optional) the left end of the date line. `page` counts the
 * pages of all attached contract files in order, or "last".
 */
export type Placement = { page: number | "last"; signature: PagePoint; date: PagePoint | null };

/** Used only when a signature is filed without HR having chosen (older acceptances). */
export const DEFAULT_PLACEMENT: Placement = { page: "last", signature: { x: 0.55, y: 0.9 }, date: null };

const point = (raw: unknown, field: string, label: string): PagePoint => {
  const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const x = Number(p.x), y = Number(p.y);
  if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new SignError(field, `Click on the page to place the ${label}.`);
  }
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
};

/** Checks the placement HR sent. Throws a SignError saying what is missing. */
export function parsePlacement(raw: unknown): Placement {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!input) throw new SignError("placement", "Choose where the signature goes on the contract, then finalize.");
  const page = input.page === "last" ? "last" : Number(input.page);
  if (page !== "last" && (!Number.isInteger(page) || page < 1 || page > 2000)) throw new SignError("page", "Choose a valid page.");
  return {
    page,
    signature: point(input.signature, "signature", "signature"),
    date: input.date == null ? null : point(input.date, "date", "date")
  };
}

/** Which page (0-based) of `pageCount` the placement means, or a SignError. */
export function resolvePage(placement: Placement, pageCount: number): number {
  if (pageCount < 1) throw new SignError("page", "The contract has no pages to sign.");
  if (placement.page === "last") return pageCount - 1;
  if (placement.page > pageCount) throw new SignError("page", `The contract has ${pageCount} page${pageCount === 1 ? "" : "s"}. Choose a page from 1 to ${pageCount}.`);
  return placement.page - 1;
}

/** PDF coordinates (origin bottom-left) of a clicked point. */
export function pdfPoint(pageWidth: number, pageHeight: number, p: PagePoint) {
  return { x: p.x * pageWidth, y: (1 - p.y) * pageHeight };
}

/** Bytes to base64, in chunks so large files don't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/* ---------------- Counter-signing for Panalo ---------------- */

/**
 * Panalo's counter-signature, added by the HR representative or the Managing
 * Director when they finalize. It goes on the same page as the applicant's.
 */
export type CompanySignature = {
  name: string;
  position: string;
  method: SignMethod;
  /** Handwriting (PNG bytes), when method is "drawn". */
  image?: Uint8Array;
  signature: PagePoint;
  date: PagePoint | null;
};

/** What is kept on the item and in the audit log (the image lives in storage). */
export type StoredCompanySignature = Omit<CompanySignature, "image"> & { imagePath?: string };

/** Checks what HR sent. No counter-signature (null/undefined) is fine; a half-filled one is refused. */
export function parseCompanySignature(raw: unknown): CompanySignature | null {
  if (raw == null) return null;
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const name = normalizeName(input.name);
  if (name.length < 2) throw new SignError("companyName", "Enter the name of the person signing for Panalo.");
  if (name.length > 80) throw new SignError("companyName", "That name is too long.");
  const position = normalizeName(input.position);
  if (position.length > 60) throw new SignError("companyPosition", "That position is too long.");
  const method = String(input.method ?? "");
  if (!(SIGN_METHODS as readonly string[]).includes(method)) throw new SignError("companyMethod", "Choose how to sign for Panalo.");
  const out: CompanySignature = {
    name, position, method: method as SignMethod,
    signature: point(input.signature, "companySignature", "Panalo signature"),
    date: input.date == null ? null : point(input.date, "companyDate", "Panalo date")
  };
  if (method === "drawn") out.image = decodeSignatureImage(input.signatureImage);
  return out;
}

/** The counter-signature as labelled rows for the signature record. */
export function describeCompany(company: Pick<StoredCompanySignature, "name" | "position" | "method"> | null | undefined, enteredBy: string | null) {
  if (!company?.name) return [];
  const rows = [
    { label: "Signed for Panalo by", value: `${company.name}${company.position ? ` (${company.position})` : ""}` },
    { label: "How they signed", value: company.method === "drawn" ? "Wrote their name on screen" : "Typed their name" }
  ];
  if (enteredBy) rows.push({ label: "Entered by (HR sign-in)", value: enteredBy });
  return rows;
}
