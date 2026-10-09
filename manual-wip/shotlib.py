"""Screenshot helpers for the Panalo Accounts training manual.

Runs the real /accounts/ code (served from /tmp/repo on :8000) against the
training database (finance-api on :8787). Captures a screen, masks confidential
regions (pixelated), draws numbered red callouts on the elements named, and
records each figure in a JSON register.

    import sys; sys.path.insert(0, MANUAL_DIR)
    from shotlib import *
    with sync_playwright() as p:
        s = Session(p, "fran")
        s.go("customers")
        s.shot("5.1", "Customer list", callouts=[("a.btn.primary", "New customer")], mask=[".bank"])
        s.close()

Figure files: shots/fig-<id>.png. Register: register/<area>.json (one per script; pass area=).
Rules: never capture a real secret; the MFA screens use a demo QR and key.
"""
import json, base64, os, re, urllib.request, urllib.error
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from playwright.sync_api import sync_playwright  # noqa: F401  (re-exported)

MANUAL_DIR = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(MANUAL_DIR, "shots")
REG = os.path.join(MANUAL_DIR, "register")
os.makedirs(SHOTS, exist_ok=True); os.makedirs(REG, exist_ok=True)
APP = "http://localhost:8000/accounts/"
PORTAL = "http://localhost:8000/training/"
RED = (214, 40, 57)
WHITE = (255, 255, 255)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


REST_URL = os.environ.get("PANALO_REST", "http://127.0.0.1:3998")
API_URL = os.environ.get("PANALO_API", "http://127.0.0.1:8787")
# Training people (fictional). Use the short name: Session(p, "fran").
PEOPLE = {"alex": "alex.admin", "dana": "dana.director", "fran": "fran.finance", "pat": "pat.payroll", "morgan": "morgan.pm",
          "sam": "sam.supervisor", "chris": "chris.accountant", "tom": "tom.welder", "olivia": "olivia.office", "casey": "casey.rigger",
          "jamie": "jamie.apprentice"}


def email(who):
    return who if "@" in who else f"{PEOPLE[who]}@training.panalo.test"


def uid(who):
    return json.load(urllib.request.urlopen(f"{REST_URL}/training_profiles?select=id&email=eq.{email(who)}"))[0]["id"]


def rest(path):
    """Read the training database through PostgREST (for looking up ids)."""
    return json.load(urllib.request.urlopen(f"{REST_URL}/{path}"))


def _token(sub, aal):
    b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    return f"{b({'alg': 'none'})}.{b({'sub': sub, 'aal': aal, 'exp': 4102444800})}.sig"


DEMO_QR = "data:image/svg+xml;base64," + base64.b64encode(b"""<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180'>
<rect width='180' height='180' fill='#fff'/><rect x='10' y='10' width='160' height='160' fill='none' stroke='#999' stroke-width='4' stroke-dasharray='8 6'/>
<text x='90' y='82' font-family='sans-serif' font-size='20' font-weight='bold' text-anchor='middle' fill='#555'>DEMO</text>
<text x='90' y='106' font-family='sans-serif' font-size='13' text-anchor='middle' fill='#555'>not a real code</text></svg>""").decode()


class Session:
    """A browser signed in as a training user.

    mfa: None (normal, aal2), "confirm" (has an authenticator, needs the code),
    "setup" (no authenticator yet), "signed_out" (no session at all).
    """

    def __init__(self, p, who=None, width=1360, height=900, mfa=None, area="misc"):
        self.area = area
        self.browser = p.chromium.launch()
        self.ctx = self.browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True, device_scale_factor=1)
        self.who = who
        self.user = uid(who) if who else None
        aal = "aal1" if mfa in ("confirm", "setup") else "aal2"
        if self.user and mfa != "signed_out":
            sess = {"access_token": _token(self.user, aal), "refresh_token": "r", "expires_at": 4102444800, "user": {"id": self.user, "email": email(who)}}
            self.ctx.add_init_script(f"localStorage.setItem('panalo-training-session-v1', {json.dumps(json.dumps(sess))});")
        user = self.user

        def fwd(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST"})
            req = urllib.request.Request(API_URL, data=request.post_data.encode() if request.post_data else None, method="POST",
                                         headers={"content-type": "application/json", "x-test-user": user or "", "x-test-aal": aal})
            try:
                r = urllib.request.urlopen(req); status = r.status; body = r.read()
            except urllib.error.HTTPError as e:
                status = e.code; body = e.read()
            route.fulfill(status=status, body=body, headers={"content-type": "application/json", "access-control-allow-origin": "*"})
        self.ctx.route("**/functions/v1/finance-api", fwd)
        self.ctx.route("https://storage.test/**", lambda r, q: r.fulfill(status=200, body="{}"))

        def auth(route, request):
            url = request.url
            j = lambda o, s=200: route.fulfill(status=s, body=json.dumps(o), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
            if request.method == "OPTIONS":
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"})
            if url.endswith("/user"):
                return j({"id": user, "factors": [{"id": "demo-factor", "factor_type": "totp", "status": "verified"}] if mfa == "confirm" else []})
            if url.endswith("/factors") and request.method == "POST":
                return j({"id": "demo-factor", "totp": {"qr_code": DEMO_QR, "secret": "DEMO-KEY-NOT-REAL"}})
            if "/challenge" in url:
                return j({"id": "demo-challenge"})
            if "/verify" in url:
                return j({"msg": "Invalid TOTP code entered"}, 422)
            if "token?grant_type=password" in url:
                return j({"error": "invalid_grant", "error_description": "Invalid login credentials"}, 400)
            return j({})
        self.ctx.route("**/auth/v1/**", auth)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("console", lambda m: self.errors.append(m.text) if m.type == "error" else None)
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("dialog", self._dialog)
        self.dialog_answers = []   # queue of answers for window.prompt/confirm; True = accept, False = dismiss, str = prompt text
        self.last_dialog = None

    def _dialog(self, d):
        self.last_dialog = d.message
        ans = self.dialog_answers.pop(0) if self.dialog_answers else True
        if ans is False:
            d.dismiss()
        elif isinstance(ans, str):
            d.accept(ans)
        else:
            d.accept()

    def go(self, hash_, wait=".main h1", timeout=15000):
        self.page.goto(f"{APP}#/{hash_}")
        if wait:
            self.page.wait_for_selector(wait, timeout=timeout)
        self.page.wait_for_timeout(500)

    def msg(self):
        loc = self.page.locator("[data-msg]")
        return loc.last.inner_text() if loc.count() else ""

    # ---------- capture ----------
    def _box(self, sel):
        if isinstance(sel, dict):
            return sel
        loc = self.page.locator(sel).first
        loc.wait_for(state="attached", timeout=5000)
        b = loc.bounding_box()
        if not b:
            raise RuntimeError(f"no box for {sel}")
        return b

    def shot(self, fig, title, callouts=(), mask=(), clip="main", full_page=False, pad=8, highlight=True, note=""):
        """Capture figure `fig`.

        callouts: list of (selector, label) — numbered 1..n in order.
        mask: selectors (or boxes) to pixelate.
        clip: "main" (content area), "viewport", "full" (whole page), a selector, or a box dict.
        """
        page = self.page
        page.wait_for_timeout(250)
        page.mouse.move(0, 0)
        scroll = page.evaluate("({x: window.scrollX, y: window.scrollY})")
        boxes = []
        for sel, label in callouts:
            b = self._box(sel)
            boxes.append((b, label))
        mboxes = [self._box(m) for m in mask]
        if clip == "main":
            cb = self._box(".main")
            clipbox = {"x": cb["x"], "y": cb["y"], "width": cb["width"], "height": cb["height"]}
            full_page = True
        elif clip == "viewport":
            vs = page.viewport_size
            clipbox = {"x": 0, "y": 0, "width": vs["width"], "height": vs["height"]}
        elif clip == "full":
            clipbox = None; full_page = True
        else:
            clipbox = self._box(clip); full_page = True
        path = os.path.join(SHOTS, f"fig-{fig}.png")
        if full_page:
            img_path = path + ".raw.png"
            page.screenshot(path=img_path, full_page=True)
            img = Image.open(img_path).convert("RGB"); os.remove(img_path)
            # bounding boxes are viewport-relative; full-page image is document-relative
            off = (scroll["x"], scroll["y"])
        else:
            img_path = path + ".raw.png"
            page.screenshot(path=img_path)
            img = Image.open(img_path).convert("RGB"); os.remove(img_path)
            off = (0, 0)
        def doc(b):
            return {"x": b["x"] + off[0], "y": b["y"] + off[1], "width": b["width"], "height": b["height"]}
        if clipbox is not None:
            c = doc(clipbox) if full_page else clipbox
            # main area: trim empty space below the last content
            if clip == "main":
                bottom = page.evaluate("""() => { const m = document.querySelector('.main'); let y = 0;
                  for (const el of m.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.height && r.width && el.offsetParent !== null) y = Math.max(y, r.bottom); }
                  return y + window.scrollY; }""")
                c["height"] = min(c["height"], max(200, bottom - c["y"] + 16))
            x0, y0 = max(0, int(c["x"]) - pad if clip not in ("main", "viewport") else int(c["x"])), max(0, int(c["y"]) - (pad if clip not in ("main", "viewport") else 0))
            x1, y1 = min(img.width, int(c["x"] + c["width"]) + (pad if clip not in ("main", "viewport") else 0)), min(img.height, int(c["y"] + c["height"]) + (pad if clip not in ("main", "viewport") else 0))
        else:
            x0, y0, x1, y1 = 0, 0, img.width, img.height
        # masks
        for m in mboxes:
            m = doc(m) if full_page else m
            bx = (int(m["x"]) - 2, int(m["y"]) - 2, int(m["x"] + m["width"]) + 2, int(m["y"] + m["height"]) + 2)
            region = img.crop(bx)
            small = region.resize((max(1, region.width // 10), max(1, region.height // 10)))
            region = small.resize(region.size, Image.NEAREST).filter(ImageFilter.GaussianBlur(2))
            img.paste(region, bx[:2])
            d = ImageDraw.Draw(img)
            d.rectangle(bx, outline=(150, 150, 150), width=1)
        draw = ImageDraw.Draw(img)
        font = ImageFont.truetype(FONT, 15)
        legend = []
        for i, (b, label) in enumerate(boxes, start=1):
            b = doc(b) if full_page else b
            r = (int(b["x"]) - 3, int(b["y"]) - 3, int(b["x"] + b["width"]) + 3, int(b["y"] + b["height"]) + 3)
            if highlight:
                draw.rounded_rectangle(r, radius=4, outline=RED, width=3)
            # Badge outside the box: left-middle if there is room, else right-middle, else top-left corner.
            midy = (r[1] + r[3]) / 2 if (r[3] - r[1]) < 120 else r[1] + 16
            if r[0] - 18 >= x0 + 14:
                cx, cy = r[0] - 18, midy
            elif r[2] + 18 <= x1 - 14:
                cx, cy = r[2] + 18, midy
            else:
                cx, cy = max(x0 + 14, r[0] + 14), max(y0 + 14, r[1] + 14)
            draw.ellipse((cx - 13, cy - 13, cx + 13, cy + 13), fill=RED, outline=WHITE, width=2)
            t = str(i)
            tw = draw.textlength(t, font=font)
            draw.text((cx - tw / 2, cy - 9), t, font=font, fill=WHITE)
            legend.append({"n": i, "label": label})
        img = img.crop((x0, y0, x1, y1))
        img.save(path, optimize=True)
        entry = {"figure": fig, "title": title, "file": os.path.basename(path), "callouts": legend, "route": page.url.split("#")[-1],
                 "user": self.who, "masked": len(mboxes), "note": note, "size": [img.width, img.height]}
        regp = os.path.join(REG, f"{self.area}.json")
        data = json.load(open(regp)) if os.path.exists(regp) else []
        data = [e for e in data if e["figure"] != fig] + [entry]
        json.dump(data, open(regp, "w"), indent=1)
        return entry

    def close(self):
        self.browser.close()
