"""Stage 2: quotes, invoices, receipts, purchase orders, bills, supplier payments, fixed assets (July to early October)."""
import sys, json
sys.path.insert(0, sys.path[0])
from api import *

I = json.load(open(sys.path[0] + "/ids.json"))
C, SP, PR, CC, BANK = I["C"], I["SP"], I["PR"], I["CC"], I["BANK"]
S = call("fran", "sales_setup"); P = call("fran", "purchases_setup")
tx = lambda code: next(t["id"] for t in S["taxCodes"] + P["taxCodes"] if t["code"] == code)
A = {a["code"]: a["id"] for a in rest("accounts?select=id,code")}
GST, GSTE, CAP, FREE = tx("GST"), tx("GSTE"), tx("CAP"), tx("FREE")

def line(desc, qty, price, acct, tax, project=None, cc=None, kind="other", unit=""):
    return {"description": desc, "quantity": qty, "unitPrice": price, "accountId": A[acct], "taxCodeId": tax, "kind": kind,
            "projectId": PR.get(project) if project else None, "costCodeId": CC.get(cc) if cc else None, "unit": unit}

# ---- Quotes
q1 = call("fran", "quote_save", customerId=C["port"], date="2026-07-08", expiryDate="2026-08-07", title="Wharf access platform - structural steel",
          scope="Supply, fabricate, galvanise and install the Berth 3 access platform to drawing DPT-118-S01 rev C. Includes shop drawings, hold-down bolts and site installation with our crane.",
          lines=[line("Shop drawings and engineering checks", 1, 6500, "4000", GST, kind="labour"),
                 line("Fabrication of platform steelwork", 1, 78500, "4000", GST, kind="labour"),
                 line("Structural steel, grating and handrail materials", 1, 41000, "4700", GST, kind="materials"),
                 line("Site installation (crane and 2-person crew)", 1, 16000, "4400", GST, kind="labour")])["id"]
for st in ("approved", "sent", "accepted"):
    call("fran", "quote_status", id=q1, status=st)
q2 = call("fran", "quote_save", customerId=C["energy"], date="2026-10-02", expiryDate="2026-11-01", title="Tank farm handrail upgrade",
          scope="Remove corroded handrail on tanks 1 to 3 and install new galvanised handrail and kickplate to AS 1657.",
          lines=[line("Handrail and kickplate fabrication", 120, 165, "4000", GST, kind="labour", unit="m"),
                 line("Galvanising and materials", 1, 9800, "4700", GST, kind="materials"),
                 line("Site installation", 1, 4400, "4400", GST, kind="labour")])["id"]
for st in ("approved", "sent"):
    call("fran", "quote_status", id=q2, status=st)

# ---- Invoices (approved = posted to the ledger)
def inv(cust, date, lines, ref="", approve=True):
    return call("fran", "invoice_save", customerId=C[cust], date=date, reference=ref, lines=lines, approve=approve)["id"]
INV = {}
INV["sd1"] = inv("minerals", "2026-07-24", [line("Mill 2 shutdown - milestone 1: prefabrication of DN150 spools", 1, 25000, "4300", GST, "shutdown", kind="labour")], "PO 4500-2231")
INV["m7"] = inv("minerals", "2026-07-31", [line("July maintenance call-outs (see attached timesheets)", 38, 125, "4200", GST, "maint", kind="labour", unit="h"),
                                          line("Gaskets, bolts and consumables", 1, 640, "4700", GST, "maint", kind="materials")], "PO 4500-2240")
INV["pump"] = inv("water", "2026-08-21", [line("Coded welding repairs, pump station 4 (AS/NZS 3992)", 64, 120, "4100", GST, "pump", kind="labour", unit="h"),
                                          line("Radiography of repair welds (recharge)", 1, 1950, "4700", GST, "pump", kind="materials")], "WO 77812")
INV["w1"] = inv("port", "2026-08-31", [line("Progress claim 1: 30% of contract (DPT-26-118)", 1, 42600, "4000", GST, "wharf", kind="labour")], "DPT-26-118")
INV["m8"] = inv("minerals", "2026-08-31", [line("August maintenance call-outs", 42, 125, "4200", GST, "maint", kind="labour", unit="h")], "PO 4500-2240")
INV["sd2"] = inv("minerals", "2026-09-15", [line("Mill 2 shutdown - milestone 2: site installation of spools", 1, 30000, "4300", GST, "shutdown", kind="labour")], "PO 4500-2231")
INV["w2"] = inv("port", "2026-09-30", [line("Progress claim 2: 25% of contract (DPT-26-118)", 1, 35500, "4000", GST, "wharf", kind="labour")], "DPT-26-118")
INV["m9"] = inv("minerals", "2026-09-30", [line("September maintenance call-outs", 36, 125, "4200", GST, "maint", kind="labour", unit="h"),
                                          line("Pump coupling and fasteners", 1, 820, "4700", GST, "maint", kind="materials")], "PO 4500-2240")
INV["sd3"] = inv("minerals", "2026-10-06", [line("Mill 2 shutdown - milestone 3: hydro test and handover", 1, 31500, "4300", GST, "shutdown", kind="labour")], "PO 4500-2231", approve=False)

def owing(i):
    return call("fran", "invoice_get", id=i)["invoice"]["owing"]
def receipt(cust, date, inv_key, ref):
    amt = owing(INV[inv_key])
    call("fran", "receipt_record", customerId=C[cust], date=date, amount=amt, bankAccountId=BANK, reference=ref, method="bank_transfer",
         allocations=[{"invoiceId": INV[inv_key], "amount": amt}])
receipt("minerals", "2026-08-20", "sd1", "DEMO MINERALS EFT 51120")
receipt("minerals", "2026-08-28", "m7", "DEMO MINERALS EFT 51244")
receipt("water", "2026-09-03", "pump", "DEMO WATER EFT 9031")
receipt("port", "2026-09-29", "w1", "DEMO PORT EFT 66102")

# ---- Purchase orders
def po(date, supplier, lines, submit=True, by="morgan", addr="Panalo workshop, Broadford"):
    return call(by, "po_save", supplierId=SP[supplier], date=date, deliveryAddress=addr, lines=lines, submit=submit)["id"]
po1 = po("2026-07-15", "steel", [line("DN150 Sch40 seamless pipe, 6 m length", 12, 420, "5100", GSTE, "shutdown", "200", "materials", "len"),
                                 line("DN150 90deg LR elbow, Sch40", 16, 85, "5100", GSTE, "shutdown", "200", "materials", "ea"),
                                 line("DN150 Class 150 weld-neck flange", 24, 64, "5100", GSTE, "shutdown", "200", "materials", "ea")])
for st in ("approved", "issued"):
    call("fran", "po_status", id=po1, status=st)
g = call("morgan", "po_get", id=po1)
call("morgan", "po_receive", id=po1, lines=[{"lineId": l["id"], "quantity": l["quantity"]} for l in g["lines"]])
draft = call("fran", "bill_from_po", purchaseOrderId=po1)["draft"]
B = {}
B["po1"] = call("fran", "bill_save", **{**draft, "date": "2026-07-28", "supplierReference": "DSS-INV-40871"}, then="approve")["id"]

po2 = po("2026-09-22", "consumables", [line("E7018 electrodes 3.2 mm, 5 kg pack", 12, 68, "5200", GSTE, "shutdown", "210", "consumables", "pk"),
                                       line("ER70S-6 MIG wire 0.9 mm, 15 kg spool", 6, 112, "5200", GSTE, "shutdown", "210", "consumables", "ea"),
                                       line("Argon/CO2 shielding gas, G size cylinder refill", 4, 145, "5200", GSTE, "shutdown", "210", "consumables", "ea")])
for st in ("approved", "issued"):
    call("fran", "po_status", id=po2, status=st)
g = call("morgan", "po_get", id=po2)
call("morgan", "po_receive", id=po2, lines=[{"lineId": l["id"], "quantity": l["quantity"] if i < 2 else 2} for i, l in enumerate(g["lines"])])
draft = call("fran", "bill_from_po", purchaseOrderId=po2)["draft"]
B["po2"] = call("fran", "bill_save", **{**draft, "date": "2026-09-30", "supplierReference": "DWC-118842"}, then="approve")["id"]
po3 = po("2026-10-06", "consumables", [line("Flux-cored wire E71T-1 1.2 mm, 15 kg spool", 8, 138, "5200", GSTE, "wharf", "210", "consumables", "ea"),
                                       line("Grinding discs 125 mm, box of 25", 6, 74, "5200", GSTE, "wharf", "210", "consumables", "box")],
         addr="Demo Port Terminals, Berth 3 site compound")

# ---- Bills
def bill(supplier, date, ref, lines, then="approve", **kw):
    return call("fran", "bill_save", supplierId=SP[supplier], date=date, supplierReference=ref, lines=lines, then=then, **kw)["id"]
B["welder"] = bill("tools", "2026-07-15", "DIT-20931", [line("Multi-process welding machine 400A with wire feeder", 1, 8900, "1500", CAP, kind="equipment")])
B["laptop"] = bill("tools", "2026-07-20", "DIT-20977", [line("Rugged laptop for workshop QA records", 1, 2400, "1800", CAP, kind="equipment")])
B["ute"] = bill("motors", "2026-08-01", "DM-1182", [line("Dual-cab ute, 4x4, with tray and toolboxes", 1, 54000, "1600", CAP, kind="equipment")])
B["ndt1"] = bill("ndt", "2026-08-18", "NDT-5521", [line("Radiography of 14 repair welds, pump station 4", 1, 1600, "5300", GSTE, "pump", "410", "subcontract")])
B["crane"] = bill("crane", "2026-09-12", "DCH-30418", [line("25 t mobile crane with operator, 2 days (Mill 2 shutdown)", 2, 2100, "5500", GSTE, "shutdown", "300", "equipment", "day")])
B["rig"] = bill("rigging", "2026-09-19", "Week 38", [line("Rigging labour, Mill 2 shutdown", 24, 50, "5300", FREE, "shutdown", "400", "subcontract", "h")])
B["steel2"] = bill("steel", "2026-09-25", "DSS-INV-41520", [line("310UB40 universal beam, 12 m", 8, 1180, "5100", GSTE, "wharf", "200", "materials", "len"),
                                                           line("Steel grating panels 1000 x 3000", 24, 380, "5100", GSTE, "wharf", "200", "materials", "ea")])
B["fuel"] = bill("tools", "2026-09-08", "DIT-21402", [line("Cutting discs, flap discs and PPE restock", 1, 486, "6600", GSTE, kind="consumables")])
B["ndt2"] = bill("ndt", "2026-10-03", "NDT-5604", [line("Ultrasonic testing of platform welds, Berth 3", 1, 2350, "5300", GSTE, "wharf", "410", "subcontract")], then="submit")

def pay(supplier, date, keys, ref):
    allocs = [{"billId": B[k], "amount": call("fran", "bill_get", id=B[k])["bill"]["owing"]} for k in keys]
    call("fran", "supplier_payment_record", supplierId=SP[supplier], date=date, bankAccountId=BANK, reference=ref, method="bank_transfer", allocations=allocs)
pay("tools", "2026-08-12", ["welder", "laptop"], "DIT July")
pay("motors", "2026-08-05", ["ute"], "Ute purchase")
pay("steel", "2026-08-20", ["po1"], "DSS July")
pay("ndt", "2026-09-01", ["ndt1"], "NDT-5521")
pay("rigging", "2026-09-26", ["rig"], "Week 38 net of withholding")
pay("tools", "2026-09-29", ["fuel"], "DIT-21402")

json.dump({**I, "INV": INV, "B": B, "Q": {"q1": q1, "q2": q2}, "PO": {"po1": po1, "po2": po2, "po3": po3}}, open(sys.path[0] + "/ids.json", "w"), indent=1)
print("stage 2 ok")
