"""Stage 3: fixed assets and depreciation, timesheets, pay runs, leave, STP."""
import sys, json, datetime as dt
sys.path.insert(0, sys.path[0])
from api import *

I = json.load(open(sys.path[0] + "/ids.json"))
PR, CC, BANK, SP = I["PR"], I["CC"], I["BANK"], I["SP"]

# ---- Fixed assets
al = call("fran", "assets_list")
cat = {c["name"]: c["id"] for c in al["categories"]}
lines = call("fran", "asset_from_bills")["lines"]
def from_bill(ref_word, name, category, **kw):
    l = next(x for x in lines if ref_word in x["description"])
    return call("fran", "asset_save", name=name, categoryId=cat[category], purchaseDate=l["date"], cost=l["cost"], gst=l["gst"],
                supplierId=l["supplierId"], billId=l["billId"], **kw)["id"]
AS = {
    "welder": from_bill("welding machine", "Multi-process welder 400A (workshop bay 2)", "Tools and equipment", serial="MPW400-22871", location="Workshop bay 2",
                        custodianId=None, taxMethod="diminishing_value", taxLife="10", taxNotes="Accountant to confirm instant asset write-off eligibility."),
    "laptop": from_bill("laptop", "Rugged laptop - QA records", "Office equipment", serial="RL-7Q3K9", location="Workshop office"),
    "ute": from_bill("ute", "Dual-cab ute 4x4 (site vehicle)", "Vehicles", serial="1TRN-UTE-26", location="Site fleet", taxMethod="diminishing_value", taxLife="8"),
}
AS["forklift"] = call("fran", "asset_save", name="Forklift 2.5 t LPG", categoryId=cat["Plant and machinery"], purchaseDate="2024-07-01", cost="38000", gst="3800",
                      serial="FL25-0091", location="Workshop yard", openingAccumulated="9500", openingDate="2026-06-30",
                      description="Brought in from the previous system at 30 June 2026 book value.")["id"]
for m in ("2026-07-31", "2026-08-31", "2026-09-30"):
    call("fran", "depreciation_run", periodEnd=m)

# ---- Timesheets: Mon to Fri, approved by the supervisor.
def week_entries(monday, plan):
    d0 = dt.date.fromisoformat(monday); out = []
    for i, day in enumerate(plan):
        for (proj, cc, hours, typ, note) in day:
            out.append({"date": (d0 + dt.timedelta(days=i)).isoformat(), "projectId": PR[proj], "costCodeId": CC[cc], "hours": hours, "hourType": typ, "notes": note})
    return out
TOM = lambda heavy: [[("shutdown", "110", 7.6, "ordinary", "Spool welding, bay 2")], [("shutdown", "110", 7.6, "ordinary", "")],
                     [("shutdown", "110", 7.6, "ordinary", ""), ("shutdown", "110", 2 if heavy else 0, "overtime_150", "Finish root runs before hydro")],
                     [("wharf", "100", 7.6, "ordinary", "Platform frames")], [("wharf", "100", 7.6, "ordinary", "")]]
CASEY = [[("shutdown", "140", 8, "ordinary", "Spool lifts, Mill 2")], [("shutdown", "140", 8, "ordinary", "")], [], [("maint", "140", 6, "ordinary", "Pump change-out")], []]
JAMIE = [[("wharf", "100", 7.6, "ordinary", "Cutting and fit-up")]] * 5
def clean(plan):
    return [[e for e in day if e[2] > 0] for day in plan]
weeks = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]
for i, w in enumerate(weeks):
    for who, plan in (("tom", TOM(i % 2 == 1)), ("casey", CASEY), ("jamie", JAMIE)):
        call(who, "timesheet_save", weekStart=w, entries=week_entries(w, clean(plan)), submit=True)
        t = call("sam", "timesheet_week", weekStart=w, profileId=uid(who))["timesheet"]
        call("sam", "timesheet_decide", id=t["id"], approve=True)
# This week: Tom still entering, Casey submitted and waiting.
call("tom", "timesheet_save", weekStart="2026-10-05", entries=week_entries("2026-10-05", clean(TOM(False))[:3]), submit=False)
call("casey", "timesheet_save", weekStart="2026-10-05", entries=week_entries("2026-10-05", clean(CASEY)[:2]), submit=True)

# ---- Pay runs
runs = []
for n, (start, pay) in enumerate((("2026-09-07", "2026-09-16"), ("2026-09-14", "2026-09-23"), ("2026-09-21", "2026-09-30"), ("2026-09-28", "2026-10-08"))):
    end = (dt.date.fromisoformat(start) + dt.timedelta(days=6)).isoformat()
    rid = call("pat", "pay_run_create", frequency="weekly", periodStart=start, periodEnd=end, paymentDate=pay)["id"]
    call("pat", "pay_run_recalculate", id=rid)
    call("pat", "pay_run_submit", id=rid)
    runs.append((rid, pay))
    if n < 3:
        call("dana", "pay_run_approve", id=rid)
        call("fran", "pay_run_record_payment", id=rid, bankAccountId=BANK, date=pay)
call("fran", "pay_run_record_super", id=runs[0][0], bankAccountId=BANK, date="2026-09-25")

# ---- Leave: Olivia asks for two days in November.
lt = {t["code"]: t["id"] for t in rest("leave_types?select=id,code")}
call("olivia", "leave_request", typeId=lt["ANNUAL"], start="2026-11-02", end="2026-11-03", hours=15.2, reason="Family wedding in Bendigo")

# ---- STP: settings, employee details, pay events.
call("pat", "stp_settings_save", branch="001", contactName="Pat Payroll", contactPhone="03 5700 0001", contactEmail="pat.payroll@training.panalo.test")
EMP = {r["employee_number"]: r["id"] for r in rest("employees?select=id,employee_number")}
addr = {"street": "10 Training Street", "suburb": "Broadford", "state": "VIC", "postcode": "3658"}
for num, fam, given in (("PP-101", "Welder", "Tom"), ("PP-102", "Office", "Olivia"), ("PP-103", "Rigger", "Casey"), ("PP-104", "Apprentice", "Jamie")):
    call("pat", "payroll_employee_stp_save", id=EMP[num], familyName=fam, givenNames=given, homeAddress=addr, incomeType="SAW")
ev = []
for rid, _ in runs[:2]:
    e = call("pat", "stp_event_pay", runId=rid)["id"]
    call("pat", "stp_event_check", id=e)
    call("dana", "stp_event_ready", id=e)
    ev.append(e)
# Casey's address is cleared to show a checking error on the next event.
call("pat", "payroll_employee_stp_save", id=EMP["PP-103"], familyName="Rigger", givenNames="Casey", homeAddress={}, incomeType="SAW")
ev.append(call("pat", "stp_event_pay", runId=runs[2][0])["id"])

json.dump({**I, "AS": AS, "RUNS": [r for r, _ in runs], "STP": ev, "EMP": EMP}, open(sys.path[0] + "/ids.json", "w"), indent=1)
print("stage 3 ok")
