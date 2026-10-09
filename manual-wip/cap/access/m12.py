from common import *
import time

def app(s, wait="[data-gate-title]"):
    s.page.goto(APP); s.page.wait_for_timeout(1500)

with sync_playwright() as p:
    # 1.1 signed-out gate
    s = S(p, None); app(s)
    s.page.wait_for_selector("text=Sign in to Panalo Accounts")
    s.shot("1.1", "Panalo Accounts when you are not signed in", callouts=[("[data-gate-title]", "Sign-in gate"), ("[data-gate-body] a.btn.primary", "Sign in")], clip="viewport")
    s.close()
    # 1.2 dashboard after sign-in
    s = S(p, "fran"); s.go("dashboard"); s.page.wait_for_timeout(1200)
    s.shot("1.2", "The dashboard after a successful sign-in (Fran Finance)", callouts=[("[data-org]", "Company name"), ("[data-nav]", "Menu for your role"), (".main h1", "Dashboard"), ("[data-bell]", "Notifications"), ("[data-who]", "Signed-in person"), ("[data-signout]", "Sign out")], clip="viewport")
    s.close()

    # 2.1 portal sign-in
    s = S(p, None); s.page.goto(PORTAL + "?next=/accounts/"); s.page.wait_for_selector("#sign-in-panel:not(.hidden)")
    s.shot("2.1", "The Panalo portal sign-in form", callouts=[("#email", "Email address"), ("#password", "Password"), ("#sign-in-form button[type=submit]", "Sign in"), ("#forgot-link", "Forgot password?")], clip="#sign-in-panel")
    # 2.2 wrong password
    s.page.fill("#email", "fran.finance@training.panalo.test"); s.page.fill("#password", "not-the-password")
    s.page.click("#sign-in-form button[type=submit]"); s.page.wait_for_selector("#auth-message:has-text('match')")
    s.shot("2.2", "A wrong email or password", callouts=[("#auth-message", "Sign-in message"), ("#forgot-link", "Forgot password?")], clip="#sign-in-panel")
    print("2.2", s.page.inner_text("#auth-message"))
    # 2.3 forgot password
    s.page.click("#forgot-link"); s.page.wait_for_selector("#reset-form:not(.hidden)")
    s.page.click("#reset-form button[type=submit]"); s.page.wait_for_selector("#reset-message:has-text('reset link')")
    s.shot("2.3", "Asking for a password reset link", callouts=[("#reset-email", "Email address"), ("#reset-form button[type=submit]", "Email me a reset link"), ("#reset-message", "Confirmation"), ("#back-to-sign-in", "Back to sign in")], clip="#sign-in-panel")
    print("2.3", s.page.inner_text("#reset-message"))
    s.close()

    # 2.4 temporary password gate
    s = S(p, TEMP); app(s); s.page.wait_for_selector("text=Change your temporary password first")
    s.shot("2.4", "A temporary password must be changed first", callouts=[("[data-gate-title]", "What is needed"), ("[data-gate-body] a.btn.primary", "Open the portal")], clip=".gate-card")
    s.close()
    # 2.5 portal choose your own password (portal answer for a must-change login)
    s = S(p, TEMP)
    s.page.route("**/functions/v1/training-api", lambda r, q: r.fulfill(status=200, body=json.dumps({"learner": {"mustChangePassword": True}}), headers={"content-type": "application/json", "access-control-allow-origin": "*"}))
    s.page.goto(PORTAL); s.page.wait_for_selector("#password-panel:not(.hidden)")
    s.shot("2.5", "Choosing your own password on the portal", callouts=[("#password-title", "Choose your own password"), (".password-rules", "Password rules"), ("#new-password", "New password"), ("#confirm-password", "Type it again"), ("#password-form button[type=submit]", "Save password")], clip="#password-panel",
           note="training-api bootstrap answered with mustChangePassword=true (training stub)")
    s.close()

    # 2.6 MFA set-up
    s = S(p, "fran", mfa="setup"); app(s); s.page.wait_for_selector("text=Set up two-step sign-in")
    s.shot("2.6", "Setting up two-step sign-in (demo code shown, not a real one)", callouts=[("[data-gate-title]", "Set up two-step sign-in"), (".qr img", "QR code (demo)"), ("code.secret", "Key if you can't scan"), ("#mfa-code", "6-digit code"), ("[data-mfa-form] button", "Turn on two-step sign-in")], clip=".gate-card")
    s.close()
    # 2.7 confirm + wrong code
    s = S(p, "fran", mfa="confirm"); app(s); s.page.wait_for_selector("text=Confirm it's you")
    s.page.fill("#mfa-code", "123 456"); s.page.click("[data-mfa-form] button"); s.page.wait_for_selector("[data-mfa-msg]:has-text('work')")
    s.shot("2.7", "Confirm it's you: a code that didn't work", callouts=[("#mfa-code", "6-digit code"), ("[data-mfa-form] button", "Verify"), ("[data-mfa-msg]", "Result message"), (".gate-card p.small", "Lost your phone?")], clip=".gate-card")
    print("2.7", s.page.inner_text("[data-mfa-msg]"))
    s.close()

    # 2.8 no access
    s = S(p, NEW); app(s); s.page.wait_for_selector("text=No access to Panalo Accounts")
    s.shot("2.8", "No access to Panalo Accounts", callouts=[("[data-gate-title]", "No access"), ("[data-gate-body] p", "Reason from the server"), ("[data-gate-body] a.btn", "Back to the portal")], clip=".gate-card")
    s.close()
    # 2.9 unavailable (disabled sign-in)
    s = S(p, LEAVER); app(s); s.page.wait_for_selector("text=Panalo Accounts is unavailable")
    s.shot("2.9", "Panalo Accounts is unavailable (sign-in disabled)", callouts=[("[data-gate-title]", "Unavailable"), ("[data-gate-body] .msg", "Reason")], clip=".gate-card")
    print("2.9", s.page.inner_text("[data-gate-body]"))
    s.close()
    # 2.10 checking your access (server not answering)
    s = S(p, "fran"); s.page.route("**/functions/v1/finance-api", lambda r, q: None)
    s.page.goto(APP); s.page.wait_for_timeout(2500)
    s.shot("2.10", "Checking your access… (still waiting for the server)", callouts=[("[data-gate-title]", "Checking your access…")], clip="viewport", note="finance-api held unanswered to show the waiting state")
    s.close()
    # 2.11 sign-in expired while working
    s = S(p, "fran"); s.go("dashboard"); s.page.wait_for_timeout(800)
    def expire(r, q):
        body = q.post_data or ""
        if "audit_list" in body:
            return r.fulfill(status=401, body=json.dumps({"message": "A verified session is required."}), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
        return r.fallback()
    s.page.route("**/functions/v1/finance-api", expire)
    s.page.click("a.nav-item[href='#/audit']"); s.page.wait_for_selector("text=Something went wrong")
    s.shot("2.11", "A screen that fails because the sign-in has expired", callouts=[(".main h1", "Something went wrong"), (".main .msg.bad", "Your sign-in has expired")], clip="main", note="finance-api answered 401 to simulate an expired session")
    print("2.11", s.page.inner_text(".main .msg.bad"))
    s.close()
