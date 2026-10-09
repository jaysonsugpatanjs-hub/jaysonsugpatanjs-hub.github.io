"""Stage 1: banking link, opening balances, customers, suppliers, projects, quotes."""
import sys, json
sys.path.insert(0, sys.path[0])
from api import *

S = call("fran", "sales_setup"); P = call("fran", "purchases_setup")
tx = lambda code: next(t["id"] for t in S["taxCodes"] + P["taxCodes"] if t["code"] == code)
A = {a["code"]: a["id"] for a in rest("accounts?select=id,code")}
BANK = A["1000"]

# Bank account: ledger link and bank-file settings.
o = call("fran", "banking_overview")
cba = o["companyAccounts"][0]["id"]
call("fran", "bank_settings_save", id=cba, ledgerAccountId=BANK, apcaUserId="123456", abaBankCode="WBC", abaUserName="Panalo Pipes", abaBalancing=False)

# Opening balances at 1 July 2026 (training figures).
r = call("fran", "journal_save", date="2026-07-01", memo="Opening balances 1 July 2026 (training data)", amountsAre="no_tax", post=True, lines=[
    {"accountId": BANK, "description": "Opening bank balance", "debit": 185000, "credit": 0, "taxCodeId": tx("NG")},
    {"accountId": A["1700"], "description": "Forklift at cost", "debit": 38000, "credit": 0, "taxCodeId": tx("NG")},
    {"accountId": A["1710"], "description": "Forklift accumulated depreciation", "debit": 0, "credit": 9500, "taxCodeId": tx("NG")},
    {"accountId": A["3000"], "description": "Share capital", "debit": 0, "credit": 100, "taxCodeId": tx("NG")},
    {"accountId": A["3100"], "description": "Retained earnings", "debit": 0, "credit": 213400, "taxCodeId": tx("NG")}])
assert r["status"] == "posted", r

def cust(name, **kw):
    return call("fran", "customer_save", name=name, **kw)["id"]
C = {
    "minerals": cust("Demo Minerals Processing Pty Ltd", abn="10 000 000 032", contactName="Accounts payable", email="ap@demo-minerals.training.test", phone="03 5000 1000", termsDays=30,
                     poRequired=True, billingAddress={"street": "100 Mill Road", "suburb": "Seymour", "state": "VIC", "postcode": "3660"}, revenueAccountId=A["4200"], taxCodeId=tx("GST")),
    "port": cust("Demo Port Terminals Pty Ltd", abn="12 000 000 073", contactName="Contracts officer", email="contracts@demo-port.training.test", phone="03 5000 2000", termsDays=30,
                 billingAddress={"street": "2 Wharf Street", "suburb": "Geelong", "state": "VIC", "postcode": "3220"}, revenueAccountId=A["4000"], taxCodeId=tx("GST")),
    "water": cust("Demo Water Authority", abn="14 000 000 082", contactName="Maintenance planner", email="maintenance@demo-water.training.test", phone="03 5000 3000", termsDays=14,
                  billingAddress={"street": "5 Reservoir Lane", "suburb": "Kilmore", "state": "VIC", "postcode": "3764"}, revenueAccountId=A["4100"], taxCodeId=tx("GST")),
    "energy": cust("Demo Energy Services Pty Ltd", contactName="Site coordinator", email="site@demo-energy.training.test", termsDays=30,
                   billingAddress={"street": "8 Turbine Drive", "suburb": "Wodonga", "state": "VIC", "postcode": "3690"}),
}

def supp(name, **kw):
    return call("fran", "supplier_save", name=name, **kw)["id"]
SP = {
    "steel": supp("Demo Steel Supplies Pty Ltd", abn="12 000 000 041", contactName="Trade desk", email="sales@demo-steel.training.test", phone="03 5100 1000", termsDays=30,
                  expenseAccountId=A["5100"], taxCodeId=tx("GSTE")),
    "consumables": supp("Demo Welding Consumables Pty Ltd", abn="14 000 000 050", contactName="Branch counter", email="orders@demo-weld.training.test", termsDays=30,
                        expenseAccountId=A["5200"], taxCodeId=tx("GSTE")),
    "crane": supp("Demo Crane Hire Pty Ltd", abn="16 000 000 091", contactName="Bookings", email="bookings@demo-crane.training.test", termsDays=14, subcontractor=True, tpar=True,
                  expenseAccountId=A["5500"], taxCodeId=tx("GSTE"), insuranceExpiry="2026-10-31"),
    "ndt": supp("Demo NDT Inspections Pty Ltd", abn="17 000 000 009", contactName="Scheduling", email="jobs@demo-ndt.training.test", termsDays=14, subcontractor=True, tpar=True,
                expenseAccountId=A["5300"], taxCodeId=tx("GSTE"), insuranceExpiry="2027-03-31"),
    "rigging": supp("Demo Rigging Services (no ABN)", contactName="Owner", subcontractor=True, tpar=True, gstRegistered=False, termsDays=7,
                    expenseAccountId=A["5300"], taxCodeId=tx("FREE")),
    "motors": supp("Demo Motors Pty Ltd", abn="19 000 000 018", contactName="Fleet sales", termsDays=7, expenseAccountId=A["1600"], taxCodeId=tx("CAP")),
    "tools": supp("Demo Industrial Tools Pty Ltd", abn="21 000 000 027", contactName="Trade sales", termsDays=30, expenseAccountId=A["6700"], taxCodeId=tx("GSTE")),
}
for k, (nm, bsb, no) in {"steel": ("Demo Steel Supplies", "063-000", "1020 3040"), "consumables": ("Demo Welding Consumables", "063-000", "2030 4050"),
                         "crane": ("Demo Crane Hire", "064-000", "3040 5060"), "rigging": ("Demo Rigging Services", "065-000", "4050 6070"),
                         "motors": ("Demo Motors", "066-000", "5060 7080"), "tools": ("Demo Industrial Tools", "067-000", "6070 8090")}.items():
    r = call("fran", "supplier_bank_request", supplierId=SP[k], accountName=nm, bsb=bsb, accountNumber=no)
    call("dana", "approval_decide", approvalId=r["approvalId"], approve=True, comment="Verified by phone on a known number (training)")

# Labour classes for people on timesheets.
ps = call("morgan", "projects_setup")
LC = {c["code"]: c["id"] for c in rest("labour_classes?select=id,code")}
for who, cls in (("tom", "WELDER"), ("casey", "RIGGER"), ("jamie", "APP"), ("sam", "SUP")):
    call("morgan", "labour_assign", profileId=uid(who), classId=LC[cls])

CC = {c["code"]: c["id"] for c in ps["costCodes"]}
def proj(name, status="active", **kw):
    pid = call("morgan", "project_save", name=name, managerId=uid("morgan"), **kw)["id"]
    if status != "tender":
        call("morgan", "project_status", id=pid, status=status)
    return pid
PR = {
    "shutdown": proj("Mill 2 shutdown pipework", customerId=C["minerals"], site="Mill 2, Demo Minerals processing plant", customerReference="PO 4500-2231",
                     billingType="fixed_price", contractValue="86,500", startDate="2026-07-06", endDate="2026-10-30",
                     notes="Replace DN150 and DN200 slurry spools during the October shutdown window. Hold point: client hydro test sign-off.",
                     budgets=[{"costCodeId": CC["110"], "hours": 320, "amount": 20800}, {"costCodeId": CC["140"], "hours": 260, "amount": 16900},
                              {"costCodeId": CC["200"], "amount": 18500}, {"costCodeId": CC["210"], "amount": 3200}, {"costCodeId": CC["300"], "amount": 6500},
                              {"costCodeId": CC["410"], "amount": 4200}]),
    "wharf": proj("Wharf access platform - structural steel", customerId=C["port"], site="Berth 3, Demo Port Terminals", customerReference="Contract DPT-26-118",
                  billingType="fixed_price", contractValue="142,000", startDate="2026-07-20", endDate="2026-12-18",
                  budgets=[{"costCodeId": CC["100"], "hours": 600, "amount": 39000}, {"costCodeId": CC["200"], "amount": 46000}, {"costCodeId": CC["120"], "hours": 180, "amount": 11700},
                           {"costCodeId": CC["300"], "amount": 9800}]),
    "pump": proj("Coded welding repairs - pump station 4", customerId=C["water"], site="Pump station 4, Demo Water Authority", billingType="schedule_of_rates",
                 contractValue="18,400", startDate="2026-08-03", endDate="2026-08-21",
                 budgets=[{"costCodeId": CC["110"], "hours": 80, "amount": 5200}, {"costCodeId": CC["410"], "amount": 1800}]),
    "maint": proj("Plant maintenance contract FY27", customerId=C["minerals"], site="Demo Minerals processing plant", billingType="schedule_of_rates",
                  contractValue="120,000", startDate="2026-07-01", endDate="2027-06-30"),
    "tender": proj("Tank farm handrail upgrade (tender)", status="tender", customerId=C["energy"], site="Demo Energy tank farm", contractValue="34,000"),
}

json.dump({"C": C, "SP": SP, "PR": PR, "CC": CC, "BANK": BANK, "CBA": cba}, open(sys.path[0] + "/ids.json", "w"), indent=1)
print("stage 1 ok")
