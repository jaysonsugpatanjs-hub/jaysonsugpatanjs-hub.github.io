from common import *
def card(t): return f".card:has(h2:text-is('{t}'))"
def union(s, sels, pad=10):
    bs = [s.page.locator(x).first.bounding_box() for x in sels]
    x0 = min(b["x"] for b in bs) - pad; y0 = min(b["y"] for b in bs) - pad
    x1 = max(b["x"] + b["width"] for b in bs) + pad; y1 = max(b["y"] + b["height"] for b in bs) + pad
    return {"x": x0 - 30, "y": y0, "width": x1 - x0 + 30, "height": y1 - y0}
RM = "section.panel:has(h2:text-is(\"What's being built\"))"
with sync_playwright() as p:
    s = S(p, "fran"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    s.shot("3.4", "Company setup, approvals, notifications and the roadmap", callouts=[(card("Company setup"), "Company setup"), (card("Approvals waiting for you"), "Approvals waiting for you"), (card("Notifications"), "Notifications"), (RM + " table", "Roadmap (fixed text)")], clip=union(s, [".cards:last-of-type", RM]))
    s.close()
