import test from "node:test";
import assert from "node:assert/strict";
import { detectFormat, guessCsvMapping, parseAmount, parseCsv, parseDate, parseOfx, parseQif, rowsFromCsv } from "../lib/bank-file.js";

test("dates and amounts as Australian banks write them", () => {
  assert.equal(parseDate("05/10/2026"), "2026-10-05");
  assert.equal(parseDate("5/10/26"), "2026-10-05");
  assert.equal(parseDate("10/05/2026", "mdy"), "2026-10-05");
  assert.equal(parseDate("2026-10-05"), "2026-10-05");
  assert.equal(parseDate("05 Oct 2026"), "2026-10-05");
  assert.equal(parseDate("5-Sept-2026"), "2026-09-05");
  assert.equal(parseDate("20261005120000[+10:EST]"), "2026-10-05");
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseAmount("$1,234.56"), "1234.56");
  assert.equal(parseAmount("-1,234.5"), "-1234.50");
  assert.equal(parseAmount("(15.00)"), "-15.00");
  assert.equal(parseAmount("15.00 DR"), "-15.00");
  assert.equal(parseAmount("15.00 CR"), "15.00");
  assert.equal(parseAmount("15.00-"), "-15.00");
  assert.equal(parseAmount("EFTPOS 1234"), null);
  assert.equal(parseAmount("1.005"), null);
});

test("CSV without a header (CBA style): date, amount, description, balance", () => {
  const rows = parseCsv('05/10/2026,"-15.00","ACCOUNT FEE","+6,030.00"\r\n02/10/2026,"+1100.00","DIRECT CREDIT HUNTER, INV-1001","+6100.00"\n');
  const m = guessCsvMapping(rows);
  assert.deepEqual([m.header, m.date, m.amount, m.description, m.balance], [false, 0, 1, 2, 3]);
  const { rows: out, errors } = rowsFromCsv(rows, m);
  assert.equal(errors.length, 0);
  assert.deepEqual(out[1], { date: "2026-10-02", amount: "1100.00", description: "DIRECT CREDIT HUNTER, INV-1001", reference: "", balance: "6100.00", externalId: null });
});

test("CSV with a header and debit and credit columns (Westpac style)", () => {
  const rows = parseCsv("Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial\n032000123456,05/10/2026,ACCOUNT FEE,15.00,,6030.00,FEE,\n032000123456,02/10/2026,DEPOSIT HUNTER,,1100.00,6100.00,DEP,000123\n");
  const m = guessCsvMapping(rows);
  assert.deepEqual([m.header, m.date, m.amount, m.debit, m.credit, m.description, m.balance, m.reference], [true, 1, -1, 3, 4, 2, 5, 7]);
  const { rows: out } = rowsFromCsv(rows, m);
  assert.equal(out[0].amount, "-15.00");
  assert.equal(out[1].amount, "1100.00");
  assert.equal(out[1].reference, "000123");
  const flipped = rowsFromCsv(rows, m, { flip: true }).rows;
  assert.equal(flipped[0].amount, "15.00");
});

test("bad lines are reported, blank lines skipped", () => {
  const rows = parseCsv("Date,Amount,Description\n99/99/2026,5,X\n,,\n05/10/2026,,Y\n");
  const r = rowsFromCsv(rows, guessCsvMapping(rows));
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 2);
});

test("OFX (SGML) with FITIDs and the ledger balance", () => {
  const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-55.00<FITID>A1<NAME>BP EXPRESS 1234<MEMO>FUEL
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261002120000<TRNAMT>1100.00<FITID>A2<NAME>HUNTER &amp; CO<CHECKNUM>77
</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>3815.00<DTASOF>20261008</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  assert.equal(detectFormat("statement.qfx", ofx), "ofx");
  const r = parseOfx(ofx);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { date: "2026-10-03", amount: "-55.00", description: "BP EXPRESS 1234 FUEL", reference: "", balance: null, externalId: "A1" });
  assert.equal(r.rows[1].description, "HUNTER & CO");
  assert.equal(r.rows[1].reference, "77");
  assert.equal(r.balance, "3815.00");
  assert.equal(r.balanceDate, "2026-10-08");
});

test("QIF", () => {
  const qif = "!Type:Bank\nD05/10/2026\nT-15.00\nPACCOUNT FEE\n^\nD02/10/2026\nT1,100.00\nPHUNTER\nMINV-1001\nN55\n^\n";
  assert.equal(detectFormat("x.txt", qif), "qif");
  const r = parseQif(qif);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[1], { date: "2026-10-02", amount: "1100.00", description: "HUNTER INV-1001", reference: "55", balance: null, externalId: null });
});

test("a quote inside an unquoted cell is just a character", () => {
  const rows = parseCsv('01/10/2026,-5.00,BUNNINGS 12" SAW,100.00\n02/10/2026,-6.00,NEXT LINE,94.00\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0][2], 'BUNNINGS 12" SAW');
  assert.deepEqual(parseCsv('"A, B","C ""D"""\n')[0], ["A, B", 'C "D"']);
});

test("QIF dates: month/day order and space padding", () => {
  assert.equal(parseDate("1/ 5'24", "mdy"), "2024-01-05");
  assert.equal(parseDate("01/02'2024", "mdy"), "2024-01-02");
  assert.equal(parseDate("01/02'2024"), "2024-02-01");
  const r = parseQif("!Type:Bank\nD1/ 5'24\nT-10.00\nPSHOP\n^\n", "mdy");
  assert.equal(r.rows[0].date, "2024-01-05");
});
