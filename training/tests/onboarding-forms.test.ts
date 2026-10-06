import test from "node:test";
import assert from "node:assert/strict";
import { describeAnswers, FORMS, FormError, validAbn, validateAnswers, validTfn } from "../../supabase/functions/_shared/onboarding-forms.ts";

const fails = (doc: string, answers: unknown, field: string) =>
  assert.throws(() => validateAnswers(doc, answers), (e: unknown) => e instanceof FormError && e.field === field);

test("TFN and ABN check digits", () => {
  assert.ok(validTfn("123 456 782"));
  assert.ok(!validTfn("123 456 789"));
  assert.ok(!validTfn("12345"));
  assert.ok(validAbn("51 824 753 556"));
  assert.ok(!validAbn("51 824 753 557"));
});

test("TFN declaration: TFN only asked when providing it, stored as digits", () => {
  const base = { pay_basis: "Casual", residency: "An Australian resident", tax_free_threshold: "Yes", study_loan: "No", declaration: true, signature: "Dana Whitford" };
  const out = validateAnswers("tfn_declaration", { ...base, tfn_option: "I'll provide my TFN", tfn: "123-456-782" });
  assert.equal(out.tfn, "123456782");
  fails("tfn_declaration", { ...base, tfn_option: "I'll provide my TFN", tfn: "123456789" }, "tfn");
  const later = validateAnswers("tfn_declaration", { ...base, tfn_option: "I've applied for a TFN and will provide it later", tfn: "garbage" });
  assert.equal(later.tfn, undefined, "unasked answers are dropped");
  fails("tfn_declaration", { ...base, tfn_option: "I'll provide my TFN", tfn: "123456782", declaration: false }, "declaration");
  fails("tfn_declaration", { ...base, tfn_option: "Something else" }, "tfn_option");
});

test("bank, contact and address formats", () => {
  assert.deepEqual(validateAnswers("bank_details", { account_name: "D Whitford", bsb: "062-000", account_number: "1234 5678" }),
    { account_name: "D Whitford", bsb: "062000", account_number: "12345678" });
  fails("bank_details", { account_name: "D", bsb: "06200", account_number: "12345678" }, "bsb");
  fails("emergency_contact", { name: "Sam Lee", relationship: "Partner", phone: "12345" }, "phone");
  assert.ok(validateAnswers("emergency_contact", { name: "Sam Lee", relationship: "Partner", phone: "+61 412 345 678" }));
  fails("personal_details", { date_of_birth: "2999-01-01", mobile: "0412345678", street: "1 Main St", suburb: "Penrith", state: "NSW", postcode: "2750" }, "date_of_birth");
  fails("personal_details", { date_of_birth: "1990-01-01", mobile: "0412345678", street: "1 Main St", suburb: "Penrith", state: "XX", postcode: "2750" }, "state");
});

test("visa details only for visa holders; expiry must be in the future", () => {
  const citizen = validateAnswers("right_to_work", { status: "An Australian citizen", document: "Australian passport", document_number: "PA1234567", visa_subclass: "482" });
  assert.equal(citizen.visa_subclass, undefined);
  fails("right_to_work", { status: "Visa holder", document: "Foreign passport", document_number: "X1", passport_country: "Philippines", visa_subclass: "482", visa_expiry: "2001-01-01" }, "visa_expiry");
});

test("uploads are not forms; HR sees labelled answers with sensitive flags", () => {
  assert.throws(() => validateAnswers("white_card", {}), FormError);
  assert.equal(FORMS.contract, undefined);
  const rows = describeAnswers("bank_details", { account_name: "D", bsb: "062000", account_number: "12345678" });
  assert.deepEqual(rows.map(r => [r.label, r.sensitive]), [["Account name", false], ["BSB", false], ["Account number", true]]);
});
