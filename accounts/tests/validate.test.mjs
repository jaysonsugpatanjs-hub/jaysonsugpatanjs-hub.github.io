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

test("document lines match the database rounding", async () => {
  const { docLine, docTotals, allocateOldestFirst, noAbnWithholding } = await import("../lib/validate.js");
  assert.deepEqual(docLine({ quantity: 3, unitPrice: 333.33, discountPercent: 0 }, 0.1, "exclusive"), { amount: 999.99, gst: 100 });
  assert.deepEqual(docLine({ quantity: 2, unitPrice: 100, discountPercent: 10 }, 0.1, "exclusive"), { amount: 180, gst: 18 });
  assert.deepEqual(docLine({ quantity: 1, unitPrice: 110, discountPercent: 0 }, 0.1, "inclusive"), { amount: 110, gst: 10 });
  assert.deepEqual(docLine({ quantity: 1, unitPrice: 0.05, discountPercent: 50 }, 0, "exclusive"), { amount: 0.03, gst: 0 });
  const rates = { g: 0.1, f: 0 };
  assert.deepEqual(docTotals([{ quantity: 3, unitPrice: 333.33, taxCodeId: "g" }, { quantity: 2, unitPrice: 100, discountPercent: 10, taxCodeId: "g" }], rates, "exclusive"),
    { subtotal: 1179.99, gst: 118, total: 1297.99 });
  assert.deepEqual(docTotals([{ quantity: 1, unitPrice: 550, taxCodeId: "g" }], rates, "inclusive"), { subtotal: 500, gst: 50, total: 550 });
  assert.ok(Number.isNaN(docTotals([{ quantity: "x", unitPrice: 1 }], rates, "exclusive").total));
  assert.deepEqual(allocateOldestFirst([{ id: "b", dueDate: "2026-09-01", owing: 100 }, { id: "a", dueDate: "2026-08-01", owing: 60 }], 120), { a: 60, b: 60 });
  assert.equal(noAbnWithholding(1000, 1000, 0.47), 470);
  assert.equal(noAbnWithholding(75, 75, 0.47), 0);
});

test("timesheet hours match the database", async () => {
  const { mondayOf, entryHours, labourCost } = await import("../lib/validate.js");
  assert.equal(mondayOf("2026-09-09"), "2026-09-07");
  assert.equal(mondayOf("2026-09-13"), "2026-09-07");
  assert.equal(mondayOf("2026-09-07"), "2026-09-07");
  assert.equal(entryHours("07:00", "15:30", 30), 8);
  assert.equal(entryHours("22:00", "06:00", 30), 7.5);
  assert.equal(entryHours("06:30", "15:00", 30), 8);
  assert.equal(entryHours("7am", "15:00", 0), null);
  assert.equal(labourCost(2, 65, "overtime_150"), 195);
  assert.equal(labourCost(23.5, 65, "ordinary"), 1527.5);
});

test("TFN check digits", async () => {
  const { validTfn } = await import("../lib/validate.js");
  assert.ok(validTfn("123 456 782"));
  assert.ok(!validTfn("123 456 789"));
  assert.ok(!validTfn("12345"));
});
