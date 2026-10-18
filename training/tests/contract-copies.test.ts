import assert from "node:assert/strict";
import test from "node:test";
import { copyDisplayName, copyFolder, CopyError, isStoredCopyName, parseCopyName, storedCopyName } from "../../supabase/functions/_shared/contract-copies.ts";

test("PDF and Word files are accepted, other types are not", () => {
  assert.deepEqual(parseCopyName("Contract.PDF"), { stem: "Contract", ext: "pdf" });
  assert.deepEqual(parseCopyName("My contract (filled in).docx"), { stem: "My-contract-filled-in", ext: "docx" });
  assert.deepEqual(parseCopyName("old.doc"), { stem: "old", ext: "doc" });
  for (const bad of ["photo.png", "script.exe", "noextension", "", null, "contract.pdf.exe"]) {
    assert.throws(() => parseCopyName(bad), CopyError);
  }
});

test("an empty stem falls back to a plain name", () => {
  assert.equal(parseCopyName("....pdf").stem.length > 0, true);
  assert.equal(parseCopyName("???.docx").stem, "contract");
});

test("stored names round-trip and keep the stamp out of what people see", () => {
  const stored = storedCopyName("Contract-filled", "docx", "lx3k9a2z");
  assert.equal(stored, "Contract-filled-lx3k9a2z.docx");
  assert.ok(isStoredCopyName(stored));
  assert.equal(copyDisplayName(stored), "Contract-filled.docx");
  assert.equal(copyDisplayName("plain.pdf"), "plain.pdf");
});

test("a name from the browser cannot reach outside the folder", () => {
  for (const bad of ["../x.pdf", "a/b.pdf", "..pdf", "a..b.pdf", "x.exe", "", 5, undefined, "a b.pdf", `${"a".repeat(200)}.pdf`]) {
    assert.equal(isStoredCopyName(bad), false, String(bad));
  }
  assert.equal(copyFolder("req", "item"), "req/item/filled");
});
