// Rules for signing the employment contract online. Pure functions only (no
// Deno, network or database), so training/tests can run them under Node.
//
// HR attaches the contract as a PDF. The applicant ticks that they have read
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

/** Contracts must be PDFs, so everyone sees the same pages. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
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
