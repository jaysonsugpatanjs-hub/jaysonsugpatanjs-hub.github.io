from common import *
def card(t): return f".card:has(h2:text-is('{t}'))"
with sync_playwright() as p:
    s = S(p, "tom"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    s.shot("3.6", "An employee's dashboard (Tom Welder)", callouts=[("a.nav-item[href='#/my-pay']", "My pay"), ("a.nav-item[href='#/timesheets']", "Timesheets"), (card("Approvals waiting for you"), "Approvals waiting for you"), (card("Notifications"), "Notifications")], clip="viewport")
    s.close()
