from common import *
def card(t): return f".card:has(h2:text-is('{t}'))"
def rows(s, idxs, pad=10):
    bs = [s.page.locator(".cards").nth(i).bounding_box() for i in idxs]
    x0 = min(b["x"] for b in bs) - pad; y0 = min(b["y"] for b in bs) - pad
    x1 = max(b["x"] + b["width"] for b in bs) + pad; y1 = max(b["y"] + b["height"] for b in bs) + pad
    return {"x": x0 - 30, "y": y0, "width": x1 - x0 + 30, "height": y1 - y0}
with sync_playwright() as p:
    s = S(p, "fran"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    s.shot("3.1", "Ledger figures on the dashboard (Fran Finance)", callouts=[(card("Bank"), "Bank"), (card("Net profit this financial year"), "Net profit this year"), (card("GST owed (estimate)"), "GST owed (estimate)"), (card("Draft journals"), "Draft journals")], clip=rows(s, [0]))
    s.shot("3.2", "Sales and purchasing figures (Fran Finance)", callouts=[(card("Customers owe"), "Customers owe"), (card("Draft invoices"), "Draft invoices"), (card("Panalo owes suppliers"), "Panalo owes suppliers"), (card("Waiting on purchasing"), "Waiting on purchasing")], clip=rows(s, [1]))
    n = s.page.locator(".cards").count()
    s.page.locator("section.panel:has(h2:text-is(\"What's being built\"))").scroll_into_view_if_needed()
    s.shot("3.4", "Company setup, approvals, notifications and the roadmap", callouts=[(card("Company setup"), "Company setup"), (card("Approvals waiting for you"), "Approvals waiting for you"), (card("Notifications"), "Notifications"), ("section.panel:has(h2:text-is(\"What's being built\")) table", "Roadmap (fixed text)")], clip=rows(s, [n-1]) | {"height": 0} if False else "main")
    s.close()
    s = S(p, "dana"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    print("dana rows", s.page.locator(".cards").count(), [s.page.locator(".cards").nth(i).inner_text()[:40].replace("\n"," ") for i in range(s.page.locator(".cards").count())])
    s.shot("3.3", "Banking, BAS and payroll figures (Dana Director)", callouts=[(card("Bank lines to match"), "Bank lines to match"), (card("Payment batches to approve"), "Payment batches to approve"), (card("Next BAS"), "Next BAS"), (card("BAS to review"), "BAS to review"), (card("Pay runs to approve"), "Pay runs to approve"), (card("Super not yet paid"), "Super not yet paid")], clip=rows(s, [2, 3, 4]))
    s.close()
    s = S(p, "sam"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    print("sam rows", [s.page.locator(".cards").nth(i).inner_text()[:60].replace("\n"," ") for i in range(s.page.locator(".cards").count())])
    s.shot("3.5", "A supervisor's dashboard (Sam Supervisor)", callouts=[(card("Leave to approve"), "Leave to approve"), (card("Timesheets to approve"), "Timesheets to approve"), (".nav-item[href='#/timesheets'] .count", "Menu count badge")], clip="viewport")
    s.close()
    s = S(p, "tom"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    s.shot("3.6", "An employee's dashboard (Tom Welder)", callouts=[("[data-nav]", "Short menu"), (card("Company setup"), "Company setup"), (card("Approvals waiting for you"), "Approvals waiting for you"), (card("Notifications"), "Notifications")], clip="viewport")
    s.close()
