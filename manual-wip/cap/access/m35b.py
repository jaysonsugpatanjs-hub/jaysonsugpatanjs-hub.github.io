from common import *
with sync_playwright() as p:
    s = S(p, "alex"); s.go("company?step=6"); s.page.wait_for_selector("[data-step-panel] h2"); s.page.wait_for_timeout(400)
    n = s.page.locator("[data-step-panel] table.tbl tbody tr").count()
    MASK = [f"[data-step-panel] table.tbl tbody tr:nth-child({i}) td:nth-child({c})" for i in range(1, n + 1) for c in (2, 3)]
    s.shot("35.8", "A new bank account waiting for approval (bank details masked)", callouts=[("[data-step-panel] table.tbl tbody tr:first-child .chip", "Waiting for approval"), ("[data-step-panel] table.tbl tbody tr:nth-child(2) .chip", "Active account"), ("[data-retire]", "Retire")], mask=MASK, clip="[data-step-panel] table.tbl")
    s.close()
