from common import *
with sync_playwright() as p:
    s = S(p, "fran", height=1700); s.go("dashboard"); s.page.wait_for_timeout(1000)
    last = s.page.locator("[data-nav] a.nav-item").last.bounding_box()
    s.shot("4.2", "The menu for a finance administrator (Fran Finance)", callouts=[(".nav-item.active", "Current screen"), (".nav-title:text-is('Sales')", "Menu group"), ("a.nav-item[href='#/bills']", "A menu item"), ("a.nav-item[href='#/reconciliation'] .count", "Count badge"), (".nav-title:text-is('Administration')", "Administration group")], clip={"x": 0, "y": 62, "width": 285, "height": last["y"] + last["height"] - 50})
    s.close()
