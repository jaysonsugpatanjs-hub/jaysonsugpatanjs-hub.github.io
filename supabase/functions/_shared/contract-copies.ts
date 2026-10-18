// Filled-in copies of a contract.
//
// An employee or contractor can download their contract, fill it in, and send the file
// back (PDF or Word). HR reviews it and attaches the final PDF; the person then signs
// online as usual. These files sit in the private HR bucket beside the contract, in a
// "filled" folder, so nothing about signing, review or filing changes.

export const COPY_MAX_BYTES = 20 * 1024 * 1024;
export const COPY_MAX_FILES = 10;

export const COPY_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

export class CopyError extends Error {}

export const copyFolder = (requestId: string, itemId: string) => `${requestId}/${itemId}/filled`;

/** A safe file stem and lower-case extension from an uploaded file's name, or a CopyError. */
export function parseCopyName(raw: unknown): { stem: string; ext: string } {
  const name = String(raw ?? "").trim();
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!COPY_TYPES[ext]) throw new CopyError("Upload a PDF or a Word file (.doc or .docx).");
  const stem = name.slice(0, name.length - ext.length - 1)
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "contract";
  return { stem, ext };
}

/** The name a copy is stored under: the stem plus a stamp that keeps two uploads apart. */
export const storedCopyName = (stem: string, ext: string, stamp: string) => `${stem}-${stamp}.${ext}`;

/** True for a name this module could have produced. Keeps a name from the browser out of the path. */
export function isStoredCopyName(name: unknown): name is string {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,170}$/.test(name) || name.includes("..")) return false;
  const ext = name.split(".").pop()!.toLowerCase();
  return Boolean(COPY_TYPES[ext]);
}

/** The name shown to people: the stored name without the stamp added to keep uploads apart. */
export const copyDisplayName = (stored: string) => stored.replace(/-[a-z0-9]{6,10}(\.[A-Za-z0-9]+)$/, "$1");
