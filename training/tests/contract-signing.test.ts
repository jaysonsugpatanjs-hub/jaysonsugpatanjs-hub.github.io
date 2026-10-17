import test from "node:test";
import assert from "node:assert/strict";
import {
  AGREEMENT_TEXT, SIGNATURE_MAX_BYTES, SignError, decodeSignatureImage, describeSignature, looksLikePdf,
  namesMatch, normalizeName, sha256Hex, signatureImagePath, validateSignature
} from "../../supabase/functions/_shared/contract-signing.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const dataUrl = (bytes: number[] | Uint8Array, mime = "image/png") => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const fakePng = (size = 400) => Uint8Array.from({ length: size }, (_, i) => (i < PNG_HEAD.length ? PNG_HEAD[i] : i % 251));

const failsOn = (fn: () => unknown, field: string) =>
  assert.throws(fn, (e: unknown) => e instanceof SignError && e.field === field);

test("the name check ignores case and spacing, and nothing else", () => {
  assert.equal(normalizeName("  Jose   Dela \t Cruz "), "Jose Dela Cruz");
  assert.ok(namesMatch("jose dela cruz", "Jose  Dela Cruz"));
  assert.ok(!namesMatch("Jose", "Jose Dela Cruz"), "a first name alone is not a full name");
  assert.ok(!namesMatch("Jose Dela Cruz Jr", "Jose Dela Cruz"));
  assert.ok(!namesMatch("", "Jose Dela Cruz"));
});

test("typing: agreement ticked, and the name matches the register", () => {
  const ok = validateSignature({ agreed: true, method: "typed", name: " jose  dela cruz " }, "Jose Dela Cruz");
  assert.deepEqual(ok, { method: "typed", typedName: "jose dela cruz" });

  failsOn(() => validateSignature({ method: "typed", name: "Jose Dela Cruz" }, "Jose Dela Cruz"), "agreed");
  failsOn(() => validateSignature({ agreed: "yes", method: "typed", name: "Jose Dela Cruz" }, "Jose Dela Cruz"), "agreed");
  failsOn(() => validateSignature({ agreed: true, method: "typed", name: "" }, "Jose Dela Cruz"), "name");
  failsOn(() => validateSignature({ agreed: true, method: "typed", name: "Jose" }, "Jose Dela Cruz"), "name");
  failsOn(() => validateSignature({ agreed: true, method: "typed", name: "x".repeat(121) }, "Jose Dela Cruz"), "name");
  assert.throws(() => validateSignature({ agreed: true, method: "typed", name: "Jose" }, "Jose Dela Cruz"), /exactly as shown: Jose Dela Cruz/);
});

test("the method must be one we offer; junk input is rejected, not trusted", () => {
  failsOn(() => validateSignature({ agreed: true, method: "stamp" }, "A B"), "method");
  failsOn(() => validateSignature({ agreed: true }, "A B"), "method");
  failsOn(() => validateSignature(null, "A B"), "agreed");
  failsOn(() => validateSignature([], "A B"), "agreed");
  failsOn(() => validateSignature("typed", "A B"), "agreed");
});

test("writing: only a real PNG of sensible size is accepted", () => {
  const ok = validateSignature({ agreed: true, method: "drawn", signatureImage: dataUrl(fakePng()) }, "Jose Dela Cruz");
  assert.equal(ok.method, "drawn");
  assert.equal(ok.image?.length, 400);

  // Typing a name is not required when writing; the register name is recorded instead.
  assert.equal((ok as { typedName?: string }).typedName, undefined);

  failsOn(() => decodeSignatureImage(undefined), "signature");
  failsOn(() => decodeSignatureImage(""), "signature");
  failsOn(() => decodeSignatureImage(dataUrl(fakePng(), "image/jpeg")), "signature");
  failsOn(() => decodeSignatureImage(dataUrl(fakePng(), "image/svg+xml")), "signature");
  failsOn(() => decodeSignatureImage(dataUrl(new Uint8Array(400).fill(7))), "signature"); // not a PNG
  failsOn(() => decodeSignatureImage(dataUrl(PNG_HEAD)), "signature"); // too small to be a drawing
  failsOn(() => decodeSignatureImage(`data:image/png;base64,${"A".repeat(40)}!!`), "signature");
  failsOn(() => decodeSignatureImage(dataUrl(fakePng(SIGNATURE_MAX_BYTES + 1))), "signature");
  failsOn(() => decodeSignatureImage("A".repeat(2_000_000)), "signature"); // refused on length, before any pattern runs
});

test("contracts must be PDFs", () => {
  assert.ok(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj")));
  assert.ok(looksLikePdf(new TextEncoder().encode("\n\n%PDF-1.4 with a little junk before the header")));
  assert.ok(!looksLikePdf(new TextEncoder().encode("PK\u0003\u0004 word/document.xml")));
  assert.ok(!looksLikePdf(Uint8Array.from(PNG_HEAD)));
  assert.ok(!looksLikePdf(new Uint8Array(0)));
});

test("the fingerprint is a real SHA-256", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("HR sees who signed, how, what they agreed to and which exact files", () => {
  const sha = "0123456789abcdef".repeat(4);
  const typed = describeSignature({
    method: "typed", signedName: "Jose Dela Cruz", typedAs: "jose dela cruz", statement: AGREEMENT_TEXT,
    documents: [{ label: "Employment contract", fileName: "Contract.pdf", sha256: sha }]
  });
  assert.deepEqual(typed.map(r => r.label), ["Signed by", "How they signed", "They agreed to", "Contract file: Employment contract"]);
  assert.equal(typed[0].value, "Jose Dela Cruz");
  assert.equal(typed[1].value, 'Typed their full name ("jose dela cruz")');
  assert.equal(typed[3].value, `SHA-256 ${sha}`);
  assert.ok(typed.every(r => r.sensitive === false));

  const pdf = describeSignature({ method: "drawn", signedName: "Jose Dela Cruz", documents: [{ label: "Schedule", sha256: sha }] }, { pdf: true });
  assert.equal(pdf[1].value, "Wrote their name on screen");
  assert.equal(pdf[2].value, `SHA-256\n${sha.slice(0, 32)}\n${sha.slice(32)}`);

  assert.deepEqual(describeSignature(null), []);
  assert.deepEqual(describeSignature({}), []);
});

test("the stored handwriting image is only offered for handwritten signatures", () => {
  assert.equal(signatureImagePath({ method: "drawn", signaturePath: "r/i/signature-abc.png" }), "r/i/signature-abc.png");
  assert.equal(signatureImagePath({ method: "typed", signaturePath: "r/i/signature-abc.png" }), null);
  assert.equal(signatureImagePath({ method: "drawn" }), null);
  assert.equal(signatureImagePath(null), null);
});

import { DEFAULT_PLACEMENT, parsePlacement, pdfPoint, resolvePage, toBase64 } from "../../supabase/functions/_shared/contract-signing.ts";

test("placement: HR's click is a page and fractions of it, nothing else is trusted", () => {
  const ok = parsePlacement({ page: 2, signature: { x: 0.5, y: 0.9 }, date: { x: 0.6, y: 0.93 } });
  assert.deepEqual(ok, { page: 2, signature: { x: 0.5, y: 0.9 }, date: { x: 0.6, y: 0.93 } });
  assert.equal(parsePlacement({ page: "last", signature: { x: 0, y: 1 } }).date, null);
  assert.deepEqual(parsePlacement({ page: 1, signature: { x: 0.123456789, y: 0.5 } }).signature, { x: 0.1235, y: 0.5 });

  failsOn(() => parsePlacement(undefined), "placement");
  failsOn(() => parsePlacement([]), "placement");
  failsOn(() => parsePlacement({ page: 0, signature: { x: 0.5, y: 0.5 } }), "page");
  failsOn(() => parsePlacement({ page: 1.5, signature: { x: 0.5, y: 0.5 } }), "page");
  failsOn(() => parsePlacement({ page: "first", signature: { x: 0.5, y: 0.5 } }), "page");
  failsOn(() => parsePlacement({ page: 1 }), "signature");
  failsOn(() => parsePlacement({ page: 1, signature: { x: 1.2, y: 0.5 } }), "signature");
  failsOn(() => parsePlacement({ page: 1, signature: { x: "0.5", y: 0.5 } }), "signature");
  failsOn(() => parsePlacement({ page: 1, signature: { x: Number.NaN, y: 0.5 } }), "signature");
  failsOn(() => parsePlacement({ page: 1, signature: { x: 0.5, y: 0.5 }, date: { x: 0.5, y: -1 } }), "date");
  assert.doesNotThrow(() => parsePlacement(DEFAULT_PLACEMENT));
});

test("placement: the page must exist, and a click maps to PDF coordinates (origin bottom-left)", () => {
  assert.equal(resolvePage({ page: "last", signature: { x: 0, y: 0 }, date: null }, 3), 2);
  assert.equal(resolvePage({ page: 1, signature: { x: 0, y: 0 }, date: null }, 3), 0);
  assert.throws(() => resolvePage({ page: 4, signature: { x: 0, y: 0 }, date: null }, 3), /has 3 pages. Choose a page from 1 to 3/);
  assert.throws(() => resolvePage({ page: 2, signature: { x: 0, y: 0 }, date: null }, 1), /has 1 page\. Choose a page from 1 to 1/);
  assert.throws(() => resolvePage({ page: "last", signature: { x: 0, y: 0 }, date: null }, 0), SignError);

  const p = pdfPoint(600, 800, { x: 0.25, y: 0.75 });
  assert.equal(p.x, 150);
  assert.equal(p.y, 200); // 75% of the way down the page is 25% up from the bottom
});

test("base64 survives large files", () => {
  const big = Uint8Array.from({ length: 300_000 }, (_, i) => i % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(big), "base64")), big);
  assert.equal(toBase64(new Uint8Array(0)), "");
});
