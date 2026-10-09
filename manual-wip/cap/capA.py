"""Part A/B: access, sign-in, MFA, dashboard, navigation conventions."""
import sys, json
sys.path.insert(0, sys.path[0])
from cap import *
from playwright.sync_api import sync_playwright

FAKE_QR = "data:image/svg+xml;base64," + base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#fff"/><text x="90" y="95" font-size="14" text-anchor="middle">TRAINING ONLY</text></svg>').decode()

with sync_playwright() as p:
    # Portal sign-in page (no session).
    s = Session(p, None, signed_in=False)
    s.page.goto("http://localhost:8000/training/?next=/accounts/")
    s.page.wait_for_timeout(1500)
    s.page.fill("input[type=email]", "fran.finance@training.panalo.test")
    s.page.fill("input[type=password]", "not-a-real-password")
    shot(s, "F02-01", "The Panalo portal sign-in page", "M02", "/training/", callouts=[
        ("input[type=email]", "Email address Panalo invited"), ("input[type=password]", "Your password (masked)"),
        ("button:has-text('Sign in')", "Sign in"), ("button:has-text('Forgot password?')", "Forgot password?")],
        masks=[("input[type=password]", "PASSWORD - NEVER SHARE")], clip="viewport")
    s.close()

    # Accounts without a session.
    s = Session(p, None, signed_in=False)
    s.page.goto("http://localhost:8000/accounts/"); s.page.wait_for_timeout(1500)
    shot(s, "F02-02", "Panalo Accounts asks you to sign in on the portal", "M02", "/accounts/", callouts=[("a:has-text('Sign in')", "Sign in (opens the portal, then brings you back)")])
    s.close()

    # Checking your access (the first check is slowed down so it can be seen).
    import time
    def slow(req):
        if '"whoami"' in (req.post_data or ""):
            time.sleep(4)
        return None
    s = Session(p, "fran", hang=lambda r: '"whoami"' in (r.post_data or ""))
    s.page.goto("http://localhost:8000/accounts/"); s.page.wait_for_timeout(1200)
    shot(s, "F02-03", "Checking your access while Panalo Accounts loads", "M02", "/accounts/")
    s.close()

    # MFA set-up (no authenticator yet). QR code and key are fake and masked anyway.
    def mfa_api(req):
        if '"whoami"' in (req.post_data or ""):
            return 200, {"mfa": {"required": True, "satisfied": False}}
        return None
    def enrol(req):
        if req.url.endswith("/factors") and req.method == "POST":
            return {"id": "training-factor", "type": "totp", "totp": {"qr_code": FAKE_QR, "secret": "TRAININGKEYNOTREAL", "uri": "otpauth://training"}}
        if req.url.endswith("/user"):
            return {"id": "x", "factors": []}
        return None
    s = Session(p, "fran", aal="aal1", api_override=mfa_api, auth_override=enrol)
    s.page.goto("http://localhost:8000/accounts/"); s.page.wait_for_selector("#mfa-code", timeout=15000); s.page.wait_for_timeout(500)
    shot(s, "F02-04", "Setting up two-step sign-in the first time", "M02", "/accounts/", callouts=[
        ("#mfa-code", "Type the 6-digit code your authenticator app shows"), ("button:has-text('Turn on two-step sign-in')", "Turn on two-step sign-in")],
        masks=[("img[alt*='QR']", "QR CODE MASKED"), ("code", "KEY MASKED")])
    s.close()

    # MFA verification each sign-in, then a wrong code.
    def verify(req):
        if req.url.endswith("/user"):
            return {"id": "x", "factors": [{"id": "training-factor", "factor_type": "totp", "status": "verified", "friendly_name": "Panalo Accounts"}]}
        if "/challenge" in req.url:
            return {"id": "challenge-1"}
        if "/verify" in req.url:
            return 422, {"code": "mfa_verification_failed", "msg": "Invalid TOTP code entered"}
        return None
    s = Session(p, "fran", aal="aal1", api_override=mfa_api, auth_override=verify)
    s.page.goto("http://localhost:8000/accounts/"); s.page.wait_for_selector("#mfa-code", timeout=15000); s.page.wait_for_timeout(400)
    s.page.fill("#mfa-code", "123 456")
    shot(s, "F02-05", "Confirming it's you with the 6-digit code", "M02", "/accounts/", callouts=[
        ("#mfa-code", "Code from the authenticator app (spaces are ignored)"), ("button:has-text('Verify')", "Verify")])
    s.page.click("button:has-text('Verify')"); s.page.wait_for_timeout(1200)
    shot(s, "F02-06", "A code that didn't work", "M02", "/accounts/", callouts=[("[data-mfa-msg]", "Error message: try the current code")])
    s.close()

    # Temporary password and no-access gates.
    s = Session(p, "tom", api_override=lambda r: (403, {"message": "Change your temporary password on the portal first.", "code": "password_change_required"}) if '"whoami"' in (r.post_data or "") else None)
    s.page.goto("http://localhost:8000/accounts/"); s.page.wait_for_timeout(1500)
    shot(s, "F02-07", "Temporary password: choose your own on the portal first", "M02", "/accounts/", callouts=[("a:has-text('Open the portal')", "Open the portal")])
    s.close()
    s = Session(p, "casey", api_override=lambda r: (403, {"message": "Your account doesn't include Panalo Accounts. Ask an administrator if you need it.", "code": "no_access"}) if '"whoami"' in (r.post_data or "") else None)
    s.page.goto("http://localhost:8000/accounts/"); s.page.wait_for_timeout(1500)
    shot(s, "F02-08", "No access to Panalo Accounts", "M02", "/accounts/", callouts=[("a:has-text('Back to the portal')", "Back to the portal")])
    s.close()

    # Dashboard (director: the widest view).
    s = Session(p, "dana")
    s.go("dashboard", settle=1500)
    shot(s, "F01-01", "Panalo Accounts after sign-in (director's view)", "M01", "#/dashboard", callouts=[
        (".brand", "Company and product name"), ("nav.side", "Menu: what you see depends on your role"), ("button[aria-label='Notifications']", "Notifications"),
        (".main h1", "Dashboard heading: trading name, legal name and ABN")])
    shot(s, "F03-01", "The dashboard: money, work waiting and alerts", "M03", "#/dashboard", clip="main", callouts=[
        ("section.card:has(h2:text-is('Bank'))", "Bank balance in the ledger"),
        ("section.card:has(h2:text-is('Net profit this financial year'))", "Profit so far this financial year"),
        ("section.card:has(h2:text-is('GST owed (estimate)'))", "GST account balance (estimate)"),
        ("section.card:has(h2:text-is('Draft journals'))", "Journals not yet posted"),
        ("section.card:has(h2:text-is('Customers owe'))", "Receivables and overdue amount"),
        ("section.card:has(h2:text-is('Panalo owes suppliers'))", "Payables and overdue amount"),
        ("section.card:has(h2:text-is('Bank lines to match'))", "Statement lines still to match"),
        ("section.card:has(h2:text-is('Next BAS'))", "Next BAS due"),
        ("section.card:has(h2:text-is('Pay runs to approve'))", "Pay runs waiting for approval"),
        ("section.card:has(h2:text-is('Super not yet paid'))", "Super owed to funds"),
        ("section.card:has(h2:text-is('Approvals waiting for you'))", "Approvals waiting for you")])
    s.page.click("button[aria-label='Notifications']"); s.page.wait_for_timeout(700)
    shot(s, "F03-02", "The notifications panel", "M03", "#/dashboard", callouts=[("[data-notes]", "Notifications: newest first; each opens its screen"), ("[data-read-all]", "Mark all read")])
    print("errors", s.errors)
    s.close()

    # The same screen for an employee: a much shorter menu.
    s = Session(p, "tom")
    s.go("dashboard", settle=1200)
    shot(s, "F04-01", "An employee's view: only My pay and Timesheets", "M04", "#/dashboard", callouts=[("nav.side", "Menu for an employee: only what this person needs")])
    s.close()
print("capA done")
