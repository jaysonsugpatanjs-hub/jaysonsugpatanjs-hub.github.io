import sys, json, re
sys.path.insert(0, sys.path[0])
from cap import *
from dump import JS
from playwright.sync_api import sync_playwright
I = json.load(open(sys.path[0] + "/../train/ids.json"))
pb = rest_id = None
def first(path):
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:3998/{path}"))[0]["id"]
ROUTES = {
 "fran": ["customers/" + I["C"]["minerals"], "quotes", "quotes/new", "quotes/" + I["Q"]["q2"], "invoices", "invoices/new", "invoices/" + I["INV"]["sd3"],
          "invoices/" + I["INV"]["m8"], "receipts", "receipts/new", "suppliers", "suppliers/new", "suppliers/" + I["SP"]["steel"], "purchase-orders",
          "purchase-orders/" + I["PO"]["po3"], "bills", "bills/new", "bills/" + I["B"]["ndt2"], "bills/" + I["B"]["rig"], "supplier-payments", "supplier-payments/new",
          "journals", "journals/new", "chart-of-accounts", "tax-codes", "periods", "reports", "bank-accounts", "reconciliation", "bank-rules", "payment-batches",
          "payment-batches/new", "bas", "bas/" + I["BAS"]["id"], "tpar", "assets", "assets/new", "assets/" + I["AS"]["ute"], "company", "approvals", "integrations", "audit"],
 "morgan": ["projects", "projects/new", "projects/" + I["PR"]["shutdown"], "job-costing", "projects/settings", "timesheets", "purchase-orders/new"],
 "sam": ["timesheets/review", "timesheets/hours", "leave"],
 "pat": ["employees", "employees/" + I["EMP"]["PP-101"], "pay-runs", "pay-runs/new", "pay-runs/" + I["RUNS"][3], "pay-runs/" + I["RUNS"][0], "leave", "super",
         "stp", "stp/" + I["STP"][2], "payroll-reports"],
 "tom": ["timesheets", "my-pay"],
 "dana": ["approvals", "pay-runs/" + I["RUNS"][3], "payment-batches/" + first("payment_batches?select=id")],
 "alex": ["users", "company"],
}
only = sys.argv[1:] 
with sync_playwright() as p:
    for who, routes in ROUTES.items():
        s = Session(p, who)
        for r in routes:
            name = f"{who}__{re.sub('[^a-z0-9-]+', '_', r.split('/')[0] + ('_' + r.split('/')[1][:8] if '/' in r else ''))}"
            if only and not any(o in name for o in only): continue
            try:
                s.go(r, settle=1000)
                open(f"dom/{name}.txt", "w").write(s.page.eval_on_selector(".main", JS))
            except Exception as e:
                open(f"dom/{name}.txt", "w").write("ERROR " + str(e)[:300])
        s.close()
print("done")
