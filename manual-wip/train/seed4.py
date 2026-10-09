"""Stage 4: bank rules, statements, matching, reconciliation, payment batch, journals, BAS, approvals, periods."""
import sys, json
sys.path.insert(0, sys.path[0])
from api import *

I = json.load(open(sys.path[0] + "/ids.json"))
BANK, SP = I["BANK"], I["SP"]
A = {a["code"]: a["id"] for a in rest("accounts?select=id,code")}
T = {t["code"]: t["id"] for t in rest("tax_codes?select=id,code")}

# ---- Bank rules
call("fran", "bank_rule_save", name="Fuel - Demo Servo fuel card", bankAccountId=BANK, direction="out", matchText="DEMO SERVO", targetAccountId=A["6400"],
     taxCodeId=T["GSTE"], payee="Demo Servo", priority=10)
call("fran", "bank_rule_save", name="Monthly account fee", bankAccountId=BANK, direction="out", matchText="ACCOUNT FEE", targetAccountId=A["7700"],
     taxCodeId=T["ITP"], payee="Bank", priority=20)

# ---- July to September statement, built from what the bank would show.
rows = rest(f"journal_lines?select=debit,credit,journal_entries!inner(entry_date,source_type,source_ref,status)&account_id=eq.{BANK}"
            "&journal_entries.status=eq.posted&journal_entries.source_type=neq.manual&order=journal_entries(entry_date)")
def desc(j):
    st, ref = j["source_type"], j["source_ref"] or ""
    return {"customer_payment": f"DEPOSIT {ref}", "supplier_payment": f"INTERNET TFR {ref.upper()}", "pay_run_payment": f"PAYROLL PANALO {ref}",
            "super_payment": f"SUPER CLEARING {ref}"}.get(st, ref)
stmt = [{"date": r["journal_entries"]["entry_date"], "amount": f'{(r["debit"] - r["credit"]):.2f}', "description": desc(r["journal_entries"])} for r in rows]
stmt += [{"date": "2026-07-31", "amount": "-12.50", "description": "MONTHLY ACCOUNT FEE"}, {"date": "2026-08-31", "amount": "-12.50", "description": "MONTHLY ACCOUNT FEE"},
         {"date": "2026-09-30", "amount": "-12.50", "description": "MONTHLY ACCOUNT FEE"}, {"date": "2026-09-18", "amount": "-186.40", "description": "DEMO SERVO FUEL 4471 BROADFORD"}]
stmt.sort(key=lambda x: x["date"])
bal = 185000.0
for s in stmt:
    bal = round(bal + float(s["amount"]), 2); s["balance"] = f"{bal:.2f}"
call("fran", "bank_import", accountId=BANK, fileName="operating-jul-sep-2026.csv", format="csv", statementBalance=f"{bal:.2f}", balanceDate="2026-09-30", rows=stmt)

lines = call("fran", "bank_lines", accountId=BANK, status="new")["lines"]
for l in lines:
    sug = l.get("suggestions") or []
    rule = next((s for s in sug if s["type"] == "rule"), None)
    if rule:
        call("fran", "bank_create_entry", id=l["id"], payee=rule["payee"], lines=[{"accountId": rule["accountId"], "taxCodeId": rule["taxCodeId"], "amount": abs(l["amount"])}])
        continue
    m = next((s for s in sug if s.get("lineIds")), None)
    if not m:
        print("no suggestion", l["date"], l["description"], json.dumps(sug)[:300]); continue
    call("fran", "bank_match", id=l["id"], lineIds=m["lineIds"])
rec = call("fran", "bank_reconcile", accountId=BANK, date="2026-09-30", balance=f"{bal:.2f}", clearedBefore="2026-07-02", notes="July to September statement")

# ---- October statement so far: left to match during training.
oct_rows = [{"date": "2026-10-02", "amount": "33000.00", "description": "DEPOSIT DEMO MINERALS EFT 51388"},
            {"date": "2026-10-03", "amount": "-142.80", "description": "DEMO SERVO FUEL 4471 BROADFORD"},
            {"date": "2026-10-05", "amount": "-1194.14", "description": "SUPER CLEARING PANALO PR-00002 PR-00003"},
            {"date": "2026-10-06", "amount": "-19.95", "description": "CARD FEE MERCHANT TERMINAL"}]
b2 = bal
for s in oct_rows:
    b2 = round(b2 + float(s["amount"]), 2); s["balance"] = f"{b2:.2f}"
call("fran", "bank_import", accountId=BANK, fileName="operating-oct-week1.csv", format="csv", statementBalance=f"{b2:.2f}", balanceDate="2026-10-07", rows=oct_rows)

# ---- Payment batch: Fran prepares, Dana approves (left waiting).
opts = call("fran", "payment_batch_options")
src = next(s for s in opts["sources"] if s["ready"])["id"]
due = [b["id"] for b in opts["bills"] if not b.get("problem")]
call("fran", "payment_batch_create", sourceId=src, date="2026-10-09", description="Suppliers", items=[{"billId": b} for b in due])

# ---- Journals: a posted accrual and a draft for review.
r = call("fran", "journal_save", date="2026-09-30", memo="Accrue September workers compensation premium instalment", amountsAre="no_tax", post=True, lines=[
    {"accountId": A["6200"], "description": "Workers compensation - September", "debit": 1250, "credit": 0, "taxCodeId": T["NG"]},
    {"accountId": A["2500"], "description": "Accrued workers compensation", "debit": 0, "credit": 1250, "taxCodeId": T["NG"]}])
assert r["status"] == "posted", r
call("chris", "journal_save", date="2026-09-30", memo="Reclassify fuel used on the Mill 2 shutdown to site costs", amountsAre="no_tax", post=False, lines=[
    {"accountId": A["5700"], "description": "Fuel used on site - Mill 2 shutdown", "debit": 186.40, "credit": 0, "taxCodeId": T["NG"]},
    {"accountId": A["6400"], "description": "Fuel used on site - Mill 2 shutdown", "debit": 0, "credit": 186.40, "taxCodeId": T["NG"]}])

# ---- BAS for the September quarter, prepared by finance (draft).
bas = call("fran", "bas_create", frequency="quarterly", **{"from": "2026-07-01", "to": "2026-09-30"}, method="accrual")

# ---- Approvals waiting: a supplier bank change and an employee bank change.
call("fran", "supplier_bank_request", supplierId=SP["ndt"], accountName="Demo NDT Inspections", bsb="068-000", accountNumber="7080 9010")
call("pat", "payroll_bank_request", id=I["EMP"]["PP-103"], accountName="C Rigger", bsb="069-000", accountNumber="9090 1212")

# ---- Periods: July and August soft-locked after review.
per = call("fran", "periods_list")
print(json.dumps(per)[:400])
json.dump({**I, "BAS": bas, "REC": rec}, open(sys.path[0] + "/ids.json", "w"), indent=1)
print("stage 4 ok")
