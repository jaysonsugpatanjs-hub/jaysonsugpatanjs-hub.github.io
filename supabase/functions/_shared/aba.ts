// ABA (Cemtex / Direct Entry) bank file: the fixed-width format Australian
// banks accept for bulk payments. 120 characters a record, CRLF line ends:
//   0  descriptive record: bank code, user name, APCA user ID, description, date
//   1  one detail record per payment (and an optional balancing debit)
//   7  file total record: net, credit and debit totals and the detail count
// The file is only a request to the bank; payments are made when the bank
// processes it. Banks differ on whether they want a balancing record.

export type AbaSource = {
  bankCode: string;     // 3 letters, e.g. CBA
  userName: string;     // up to 26, as registered with the bank
  apcaUserId: string;   // 6 digits
  bsb: string;          // 6 digits
  accountNumber: string;
  accountTitle: string; // name on the account paying
  remitter: string;     // shown to payees, up to 16
  balancing: boolean;
};
export type AbaPayment = { bsb: string; accountNumber: string; accountName: string; amountCents: number; reference: string };

const CLEAN = /[^A-Za-z0-9 &*.,/+:'()?_%$#@!-]/g;
const text = (v: string, n: number) => String(v ?? "").replace(CLEAN, " ").replace(/\s+/g, " ").trim().toUpperCase().slice(0, n).padEnd(n, " ");
const zeros = (v: number | string, n: number) => {
  const s = String(v);
  if (!/^\d+$/.test(s) || s.length > n) throw new Error(`Bank file: ${s} doesn't fit ${n} digits.`);
  return s.padStart(n, "0");
};
const bsb = (b: string) => {
  const d = String(b).replace(/\D/g, "");
  if (!/^\d{6}$/.test(d)) throw new Error("Bank file: a BSB is 6 digits.");
  return `${d.slice(0, 3)}-${d.slice(3)}`;
};
const account = (a: string) => {
  const d = String(a).replace(/\D/g, "");
  if (!/^\d{5,9}$/.test(d)) throw new Error(`Bank file: account number ${d} must be 5 to 9 digits.`);
  return d.padStart(9, " ");
};

/** dd/mm/yy from yyyy-mm-dd. */
function ddmmyy(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error("Bank file: the processing date is missing.");
  return `${m[3]}${m[2]}${m[1].slice(2)}`;
}

function detail(p: { bsb: string; account: string; code: string; cents: number; title: string; reference: string }, src: AbaSource) {
  return "1" + bsb(p.bsb) + account(p.account) + " " + p.code + zeros(p.cents, 10) + text(p.title, 32) + text(p.reference, 18)
    + bsb(src.bsb) + account(src.accountNumber) + text(src.remitter, 16) + "00000000";
}

/**
 * Builds the file. `code` is 50 (general credit) for suppliers or 53 (pay)
 * for wages. Throws if anything won't fit the format.
 */
export function buildAba(src: AbaSource, payments: AbaPayment[], opts: { date: string; description: string; code: "50" | "53" }) {
  if (!/^[A-Z]{3}$/.test(src.bankCode)) throw new Error("Bank file: set the 3-letter bank code for the paying account.");
  if (!/^\d{6}$/.test(src.apcaUserId)) throw new Error("Bank file: set the 6-digit APCA user ID for the paying account.");
  if (!src.userName.trim()) throw new Error("Bank file: set the user name registered with the bank.");
  if (!payments.length) throw new Error("Bank file: there is nothing to pay.");
  const lines: string[] = [];
  lines.push("0" + " ".repeat(17) + "01" + src.bankCode + " ".repeat(7) + text(src.userName, 26) + zeros(src.apcaUserId, 6)
    + text(opts.description, 12) + ddmmyy(opts.date) + " ".repeat(40));
  let credit = 0;
  for (const p of payments) {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new Error("Bank file: every payment must be more than zero.");
    credit += p.amountCents;
    lines.push(detail({ bsb: p.bsb, account: p.accountNumber, code: opts.code, cents: p.amountCents, title: p.accountName, reference: p.reference }, src));
  }
  let debit = 0;
  if (src.balancing) {
    debit = credit;
    lines.push(detail({ bsb: src.bsb, account: src.accountNumber, code: "13", cents: debit, title: src.accountTitle, reference: opts.description }, src));
  }
  const count = lines.length - 1;
  lines.push("7" + "999-999" + " ".repeat(12) + zeros(Math.abs(credit - debit), 10) + zeros(credit, 10) + zeros(debit, 10) + " ".repeat(24)
    + zeros(count, 6) + " ".repeat(40));
  for (const l of lines) if (l.length !== 120) throw new Error(`Bank file: a record is ${l.length} characters, not 120.`);
  return { content: lines.join("\r\n") + "\r\n", totalCents: credit, count: payments.length };
}
