from common import *
with sync_playwright() as p:
    s = S(p, "fran"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    s.shot("1.2", "The dashboard after a successful sign-in (Fran Finance)", callouts=[("[data-org]", "Company name"), (".nav-item.active", "Menu for your role"), (".cards.figures .card", "Dashboard cards"), ("[data-bell]", "Notifications bell"), ("[data-signout]", "Sign out")], clip="viewport")
    s.close()
    s = S(p, "fran"); s.go("dashboard"); s.page.wait_for_timeout(800)
    def expire(r, q):
        if "audit_list" in (q.post_data or ""):
            return r.fulfill(status=401, body=json.dumps({"message": "A verified session is required."}), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
        return r.fallback()
    s.page.route("**/functions/v1/finance-api", expire)
    s.page.click("a.nav-item[href='#/audit']"); s.page.wait_for_selector("text=Something went wrong")
    s.shot("2.11", "A screen that fails because the sign-in has expired", callouts=[(".main h1", "Something went wrong"), (".main .msg.bad", "Your sign-in has expired"), ("[data-signout]", "Sign out, then sign in again")], clip="viewport", note="finance-api answered 401 to simulate an expired session")
    s.close()
