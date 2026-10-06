import test from "node:test";
import assert from "node:assert/strict";
import { formatAbn, formatBsb, previewNumber, setupMissing, validAbn, validAccountNumber, validAcn, validBsb, validPostcode } from "../lib/validate.js";

test("ABN and ACN check digits", () => {
  assert.ok(validAbn("51 824 753 556"));
  assert.ok(!validAbn("51 824 753 557"));
  assert.ok(!validAbn("1234"));
  assert.ok(validAcn("000 000 019"));
  assert.ok(validAcn("004 085 616"));
  assert.ok(!validAcn("004 085 617"));
});

test("bank and address formats", () => {
  assert.ok(validBsb("062-000"));
  assert.ok(!validBsb("06200"));
  assert.ok(validAccountNumber("1234 5678"));
  assert.ok(!validAccountNumber("1234"));
  assert.ok(validPostcode("2164"));
  assert.ok(!validPostcode("216"));
  assert.equal(formatAbn("51824753556"), "51 824 753 556");
  assert.equal(formatBsb("062000"), "062-000");
});

test("setup checklist matches the database rule", () => {
  assert.deepEqual(setupMissing({}), ["ABN", "business address", "email", "phone", "states you operate in", "payroll contact"]);
  assert.deepEqual(setupMissing({ abn: "x", business_address: { street: "1", postcode: "2000" }, email: "a@b.co", phone: "1", states: ["NSW"], payroll_contact: { name: "P" } }), []);
});

test("number preview", () => {
  assert.equal(previewNumber("inv-", 1001, 5), "INV-01001");
  assert.equal(previewNumber("", 7, 1), "7");
});

import { journalTotals, lineGst } from "../lib/validate.js";

test("journal GST estimate matches the ledger's rounding", () => {
  assert.equal(lineGst(1000, 0.1, "exclusive"), 100);
  assert.equal(lineGst(110, 0.1, "inclusive"), 10);
  assert.equal(lineGst(33.33, 0.1, "exclusive"), 3.33);
  assert.equal(lineGst(0.05, 0.1, "exclusive"), 0.01);
  assert.equal(lineGst(100, 0.1, "no_tax"), 0);
  const rates = { g: 0.1 };
  assert.deepEqual(journalTotals([{ debit: 1100 }, { credit: 1000, taxCodeId: "g" }], rates, "exclusive"), { debit: 1100, credit: 1100 });
  assert.deepEqual(journalTotals([{ debit: 110, taxCodeId: "g" }, { credit: 110 }], rates, "inclusive"), { debit: 110, credit: 110 });
});
