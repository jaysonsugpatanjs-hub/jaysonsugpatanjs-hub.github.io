// Onboarding items that people type in rather than upload. The server
// validates every answer against these definitions; the portal renders its
// forms from the same definitions (sent with onboarding_view), so there is a
// single source of truth.

export type FieldType = "text" | "tel" | "date" | "select" | "yesno" | "confirm";
export type Format = "tfn" | "abn" | "bsb" | "account" | "phone" | "postcode" | "past" | "future" | "name";

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  optional?: boolean;
  format?: Format;
  help?: string;
  placeholder?: string;
  /** Masked in the admin view until HR chooses to show it. */
  sensitive?: boolean;
  /** Only asked when another answer is one of these values. */
  when?: { field: string; in: string[] };
  maxLength?: number;
  autocomplete?: string;
};

export type FormDef = { intro?: string; link?: { label: string; href: string }; fields: Field[] };

const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];
const SIGN: Field[] = [
  { key: "declaration", label: "I declare the information I have given is true and correct.", type: "confirm" },
  { key: "signature", label: "Type your full name as your signature", type: "text", format: "name", autocomplete: "name" }
];
const PROVIDE_TFN = "I'll provide my TFN";
const EXISTING_FUND = "Pay into my existing super fund";
const VISA = "Visa holder";
const PASSPORT = "Passport";

export const FORMS: Record<string, FormDef> = {
  personal_details: {
    fields: [
      { key: "date_of_birth", label: "Date of birth", type: "date", format: "past", autocomplete: "bday" },
      { key: "mobile", label: "Mobile number", type: "tel", format: "phone", placeholder: "04xx xxx xxx", autocomplete: "tel" },
      { key: "street", label: "Street address", type: "text", autocomplete: "street-address" },
      { key: "suburb", label: "Suburb", type: "text", autocomplete: "address-level2" },
      { key: "state", label: "State", type: "select", options: STATES, autocomplete: "address-level1" },
      { key: "postcode", label: "Postcode", type: "text", format: "postcode", autocomplete: "postal-code" }
    ]
  },
  tfn_declaration: {
    intro: "These are the questions from the ATO tax file number declaration. HR lodges it with the ATO for you.",
    fields: [
      { key: "tfn_option", label: "Your tax file number", type: "select", options: [PROVIDE_TFN, "I've applied for a TFN and will provide it later", "I'm claiming an exemption (under 18, or on a pension or benefit)"] },
      { key: "tfn", label: "Tax file number", type: "text", format: "tfn", sensitive: true, placeholder: "123 456 782", when: { field: "tfn_option", in: [PROVIDE_TFN] } },
      { key: "pay_basis", label: "How you'll be paid", type: "select", options: ["Full-time", "Part-time", "Casual", "Labour hire"] },
      { key: "residency", label: "For tax purposes, you are", type: "select", options: ["An Australian resident", "A foreign resident", "A working holiday maker"] },
      { key: "tax_free_threshold", label: "Claim the tax-free threshold from Panalo?", type: "yesno", help: "Usually yes, unless you already claim it from another job you're keeping." },
      { key: "study_loan", label: "Do you have a study or training loan (HELP, VSL, SFSS, SSL or TSL)?", type: "yesno" },
      ...SIGN
    ]
  },
  super_choice: {
    fields: [
      { key: "choice", label: "Where should your super be paid?", type: "select", options: [EXISTING_FUND, "Pay into Panalo's default fund"], help: "If you don't choose, the law may require us to pay your existing (stapled) fund." },
      { key: "fund_name", label: "Fund name", type: "text", when: { field: "choice", in: [EXISTING_FUND] } },
      { key: "usi", label: "Fund USI", type: "text", help: "On your fund's website or annual statement. Self-managed fund? Enter its ABN; HR will ask for the bank details.", when: { field: "choice", in: [EXISTING_FUND] }, maxLength: 20 },
      { key: "member_number", label: "Your member number", type: "text", when: { field: "choice", in: [EXISTING_FUND] }, maxLength: 30 },
      ...SIGN
    ]
  },
  right_to_work: {
    intro: "HR checks visa holders on the government's VEVO service using these details.",
    fields: [
      { key: "status", label: "You are", type: "select", options: ["An Australian citizen", "A permanent resident", "A New Zealand citizen", VISA] },
      { key: "document", label: "Document you'll show", type: "select", options: ["Australian passport", "Australian birth certificate", "Australian citizenship certificate", "Foreign passport"] },
      { key: "document_number", label: "Document number", type: "text", sensitive: true, maxLength: 30 },
      { key: "passport_country", label: "Passport country", type: "text", when: { field: "document", in: ["Foreign passport"] } },
      { key: "visa_subclass", label: "Visa subclass", type: "text", placeholder: "e.g. 482", when: { field: "status", in: [VISA] }, maxLength: 10 },
      { key: "visa_expiry", label: "Visa expiry date", type: "date", format: "future", when: { field: "status", in: [VISA] } },
      { key: "visa_conditions", label: "Work conditions on your visa", type: "text", optional: true, placeholder: "e.g. 8105 – limited hours", when: { field: "status", in: [VISA] } }
    ]
  },
  photo_id: {
    intro: "Bring the original to your first day so we can sight it.",
    fields: [
      { key: "id_type", label: "Type of ID", type: "select", options: ["Driver licence", PASSPORT, "Photo card / proof of age card"] },
      { key: "id_number", label: "Licence or card number", type: "text", sensitive: true, maxLength: 30 },
      { key: "issued_by", label: "State of issue", type: "select", options: STATES, when: { field: "id_type", in: ["Driver licence", "Photo card / proof of age card"] } },
      { key: "country", label: "Country of issue", type: "text", when: { field: "id_type", in: [PASSPORT] } },
      { key: "expiry", label: "Expiry date", type: "date", format: "future" }
    ]
  },
  bank_details: {
    fields: [
      { key: "account_name", label: "Account name", type: "text" },
      { key: "bsb", label: "BSB", type: "text", format: "bsb", placeholder: "062-000" },
      { key: "account_number", label: "Account number", type: "text", format: "account", sensitive: true },
      { key: "bank", label: "Bank", type: "text", optional: true }
    ]
  },
  emergency_contact: {
    fields: [
      { key: "name", label: "Contact name", type: "text", format: "name" },
      { key: "relationship", label: "Relationship to you", type: "text", placeholder: "e.g. Partner, parent" },
      { key: "phone", label: "Phone", type: "tel", format: "phone" },
      { key: "alt_phone", label: "Other phone", type: "tel", format: "phone", optional: true }
    ]
  },
  fwis_ack: {
    link: { label: "Read the Fair Work Information Statement", href: "https://www.fairwork.gov.au/employment-conditions/national-employment-standards/fair-work-information-statement" },
    fields: [
      { key: "received", label: "I have received and read the Fair Work Information Statement.", type: "confirm" },
      { key: "signature", label: "Type your full name as your signature", type: "text", format: "name", autocomplete: "name" }
    ]
  },
  casual_statement: {
    link: { label: "Read the Casual Employment Information Statement", href: "https://www.fairwork.gov.au/employment-conditions/types-of-employees/casual-part-time-and-full-time/casual-employees" },
    fields: [
      { key: "received", label: "I have received and read the Casual Employment Information Statement.", type: "confirm" },
      { key: "signature", label: "Type your full name as your signature", type: "text", format: "name", autocomplete: "name" }
    ]
  },
  abn_details: {
    fields: [
      { key: "abn", label: "ABN", type: "text", format: "abn", placeholder: "51 824 753 556" },
      { key: "business_name", label: "Business or trading name", type: "text" },
      { key: "gst_registered", label: "Registered for GST?", type: "yesno" }
    ]
  }
};

const digits = (v: string) => v.replace(/[\s-]/g, "");

export function validTfn(value: string) {
  const d = digits(value);
  if (!/^\d{8,9}$/.test(d)) return false;
  const w = d.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : [10, 7, 8, 4, 6, 3, 5, 1];
  return [...d].reduce((sum, c, i) => sum + Number(c) * w[i], 0) % 11 === 0;
}

export function validAbn(value: string) {
  const d = digits(value);
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  return [...d].reduce((sum, c, i) => sum + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0) % 89 === 0;
}

function todaySydney() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

function formatProblem(field: Field, v: string): string | null {
  const d = digits(v);
  switch (field.format) {
    case "tfn": return validTfn(v) ? null : "That tax file number isn't valid. Check the 9 digits.";
    case "abn": return validAbn(v) ? null : "That ABN isn't valid. Check the 11 digits.";
    case "bsb": return /^\d{6}$/.test(d) ? null : "A BSB is 6 digits, like 062-000.";
    case "account": return /^\d{5,10}$/.test(d) ? null : "An account number is 5 to 10 digits.";
    case "phone": return /^(\+?61|0)[2-478]\d{8}$/.test(d.replace(/[()]/g, "")) ? null : "Enter an Australian phone number, like 0412 345 678.";
    case "postcode": return /^\d{4}$/.test(v) ? null : "A postcode is 4 digits.";
    case "name": return v.length >= 2 && /\p{L}/u.test(v) ? null : "Type your full name.";
    case "past": {
      const today = todaySydney();
      if (v >= today) return "That date must be in the past.";
      return Number(today.slice(0, 4)) - Number(v.slice(0, 4)) > 100 ? "Check the year." : null;
    }
    case "future": return v > todaySydney() ? null : "That date has already passed. Check it, or speak to HR.";
    default: return null;
  }
}

export class FormError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export function isAsked(field: Field, answers: Record<string, unknown>) {
  return !field.when || field.when.in.includes(String(answers[field.when.field] ?? ""));
}

/** Returns cleaned answers, or throws FormError naming the first problem. */
export function validateAnswers(docType: string, raw: unknown): Record<string, string | boolean> {
  const form = FORMS[docType];
  if (!form) throw new FormError("", "This item is an upload, not a form.");
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, string | boolean> = {};
  for (const field of form.fields) {
    if (!isAsked(field, input)) continue;
    const value = input[field.key];
    if (field.type === "confirm") {
      if (value !== true) throw new FormError(field.key, `Tick to confirm: "${field.label}"`);
      out[field.key] = true;
      continue;
    }
    const text = String(value ?? "").trim().replace(/\s+/g, " ");
    if (!text) {
      if (field.optional) continue;
      throw new FormError(field.key, `${field.label} is required.`);
    }
    if (text.length > (field.maxLength ?? 160)) throw new FormError(field.key, `${field.label} is too long.`);
    if (field.type === "select" && !field.options!.includes(text)) throw new FormError(field.key, `Choose an option for ${field.label}.`);
    if (field.type === "yesno" && !["Yes", "No"].includes(text)) throw new FormError(field.key, `Answer yes or no: ${field.label}`);
    if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new FormError(field.key, `${field.label} must be a date.`);
    const problem = formatProblem(field, text);
    if (problem) throw new FormError(field.key, problem);
    out[field.key] = ["tfn", "abn", "bsb", "account"].includes(field.format || "") ? digits(text) : text;
  }
  return out;
}

/** Answers as labelled rows for HR, in form order. Sensitive values are flagged for masking. */
export function describeAnswers(docType: string, answers: Record<string, unknown> | null) {
  const form = FORMS[docType];
  if (!form || !answers) return [];
  return form.fields
    .filter(f => answers[f.key] !== undefined && answers[f.key] !== "")
    .map(f => ({
      key: f.key,
      label: f.type === "confirm" ? "Declaration" : f.label,
      value: f.type === "confirm" ? (answers[f.key] === true ? `Confirmed: ${f.label}` : "Not confirmed") : String(answers[f.key]),
      sensitive: Boolean(f.sensitive)
    }));
}
