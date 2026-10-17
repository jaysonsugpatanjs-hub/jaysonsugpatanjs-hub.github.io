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
