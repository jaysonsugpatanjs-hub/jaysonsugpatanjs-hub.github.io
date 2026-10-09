"""Screenshot capture and annotation for the Panalo Accounts manual.

Captures come from the current release running on the training database
(fictional "Demo" organisations and training people). Each figure gets
numbered callouts, highlight boxes and masks, and a register entry.
"""
import json, base64, os, urllib.request, urllib.error
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "shots")
REST_URL = os.environ.get("PANALO_REST", "http://127.0.0.1:3998")
API_URL = os.environ.get("PANALO_API", "http://127.0.0.1:8787")
REG = os.path.join(OUT, f"register_{os.environ.get('PANALO_PART', 'A')}.json")
os.makedirs(OUT, exist_ok=True)
YELLOW, DARK, RED = (255, 194, 14), (37, 38, 39), (214, 49, 43)
F_NUM = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 17)
F_MASK = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 12)
EMAIL = {"alex": "alex.admin", "dana": "dana.director", "fran": "fran.finance", "pat": "pat.payroll", "morgan": "morgan.pm",
         "sam": "sam.supervisor", "chris": "chris.accountant", "tom": "tom.welder", "olivia": "olivia.office", "casey": "casey.rigger",
         "jamie": "jamie.apprentice"}
ROLE = {"alex": "System admin (Super admin)", "dana": "Director / owner", "fran": "Finance admin", "pat": "Payroll admin", "morgan": "Project manager",
        "sam": "Supervisor", "chris": "Accountant / auditor", "tom": "Employee (welder)", "olivia": "Employee (office)", "casey": "Employee (casual rigger)",
        "jamie": "Employee (apprentice)"}

def _load():
    return json.load(open(REG)) if os.path.exists(REG) else {}

def uid(who):
    e = f"{EMAIL[who]}@training.panalo.test"
    return json.load(urllib.request.urlopen(f"{REST_URL}/training_profiles?select=id&email=eq.{e}"))[0]["id"]

def _token(sub, aal="aal2"):
    b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    return f"{b({'alg': 'none'})}.{b({'sub': sub, 'aal': aal, 'exp': 4102444800})}.sig"

class Session:
    """A browser signed in as one of the training people."""
    def __init__(self, p, who, width=1360, height=860, aal="aal2", signed_in=True, api_override=None, auth_override=None, hang=None):
        self.who = who
        self.browser = p.chromium.launch()
        self.ctx = self.browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True, device_scale_factor=1)
        self.errors = []
        user = uid(who) if who else None
        if signed_in and who:
            sess = {"access_token": _token(user, aal), "refresh_token": "r", "expires_at": 4102444800, "user": {"id": user, "email": f"{EMAIL[who]}@training.panalo.test"}}
            self.ctx.add_init_script(f"localStorage.setItem('panalo-training-session-v1', {json.dumps(json.dumps(sess))});")
        def fwd(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST"})
            if hang and hang(request):
                return  # left unanswered on purpose (shows the loading state)
            if api_override:
                o = api_override(request)
                if o is not None:
                    status, body = o
                    return route.fulfill(status=status, body=json.dumps(body), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
            req = urllib.request.Request(API_URL, data=request.post_data.encode() if request.post_data else None, method="POST",
                                         headers={"content-type": "application/json", "x-test-user": user or ""})
            try:
                r = urllib.request.urlopen(req); status = r.status; body = r.read()
            except urllib.error.HTTPError as e:
                status = e.code; body = e.read()
            route.fulfill(status=status, body=body, headers={"content-type": "application/json", "access-control-allow-origin": "*"})
        self.ctx.route("**/functions/v1/finance-api", fwd)
        self.ctx.route("https://storage.test/**", lambda r, q: r.fulfill(status=200, body="{}"))
        def auth(route, request):
            if auth_override:
                o = auth_override(request)
                if o is not None:
                    st, bd = o if isinstance(o, tuple) else (200, o)
                    return route.fulfill(status=st, body=json.dumps(bd), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
            route.fulfill(status=200, body=json.dumps({"all": [], "totp": []}), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
        self.ctx.route("**/auth/v1/**", auth)
        self.page = self.ctx.new_page()
        self.page.on("console", lambda m: self.errors.append(m.text) if m.type == "error" else None)
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("dialog", self._dialog)
        self.dialog_answer = None
        self.dialogs = []

    def _dialog(self, d):
        self.dialogs.append((d.type, d.message))
        if d.type == "prompt":
            d.accept(self.dialog_answer or "Training")
        else:
            d.accept()

    def go(self, route, wait="h1", settle=600):
        self.page.goto(f"http://localhost:8000/accounts/#/{route}")
        self.page.wait_for_selector(f".main {wait}", timeout=20000)
        self.page.wait_for_timeout(settle)

    def close(self):
        self.browser.close()


def _box(page, target):
    if isinstance(target, dict):
        return target
    loc = page.locator(target).first if isinstance(target, str) else target
    loc.scroll_into_view_if_needed(timeout=5000)
    return loc.bounding_box()

def shot(s, fig, title, module, route, callouts=(), masks=(), highlight=(), clip=None, full=False, caption="", purpose="", arrows=(), pad=8, note="", looking="", click="", why=""):
    """Capture and annotate.

    callouts: [(selector|locator|box, "what it is")] numbered in order.
    masks: [(selector|box, "label")] blacked out and labelled.
    clip: None = viewport; "main" = the main column (full height); selector = that element; dict = box.
    """
    page = s.page
    if full or clip not in (None, "viewport"):
        h = page.evaluate("Math.max(document.querySelector('.main') ? document.querySelector('.main').scrollHeight + 70 : 0, document.body.scrollHeight)")
        page.set_viewport_size({"width": page.viewport_size["width"], "height": int(min(max(h, 600), 3200))})
        page.wait_for_timeout(400)
    boxes = [(_box(page, t), lbl) for t, lbl in callouts]
    mboxes = [(_box(page, t), lbl) for t, lbl in masks]
    hboxes = [_box(page, t) for t in highlight]
    page.evaluate("window.scrollTo(0,0)")
    page.wait_for_timeout(150)
    # recompute after scrolling back to the top (boxes are viewport-relative)
    boxes = [(_box(page, t) if not isinstance(t, dict) else t, lbl) for t, lbl in callouts]
    mboxes = [(_box(page, t) if not isinstance(t, dict) else t, lbl) for t, lbl in masks]
    hboxes = [_box(page, t) if not isinstance(t, dict) else t for t in highlight]
    page.evaluate("window.scrollTo(0,0)")
    path = os.path.join(OUT, f"{fig}.png")
    if clip in (None, "viewport"):
        page.screenshot(path=path)
        ox, oy = 0, 0
    else:
        cb = _box(page, ".main" if clip == "main" else clip) if not isinstance(clip, dict) else clip
        page.evaluate("window.scrollTo(0,0)")
        vw, vh = page.viewport_size["width"], page.viewport_size["height"]
        x, y = max(cb["x"] - pad, 0), max(cb["y"] - pad, 0)
        cb = {"x": x, "y": y, "width": min(cb["width"] + 2 * pad, vw - x), "height": min(cb["height"] + 2 * pad, vh - y)}
        page.screenshot(path=path, clip=cb)
        ox, oy = cb["x"], cb["y"]
    img = Image.open(path).convert("RGB")
    d = ImageDraw.Draw(img)
    def rel(b):
        return (b["x"] - ox, b["y"] - oy, b["x"] - ox + b["width"], b["y"] - oy + b["height"])
    for b, lbl in mboxes:
        x0, y0, x1, y1 = [int(v) for v in rel(b)]
        region = img.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(9))
        img.paste(region, (x0, y0))
        d.rectangle((x0, y0, x1, y1), fill=(60, 60, 64))
        d.text(((x0 + x1) / 2, (y0 + y1) / 2), lbl or "MASKED", font=F_MASK, fill=(255, 255, 255), anchor="mm")
    for b in hboxes:
        x0, y0, x1, y1 = rel(b)
        d.rectangle((x0 - 4, y0 - 4, x1 + 4, y1 + 4), outline=RED, width=3)
    for n, (b, lbl) in enumerate(boxes, 1):
        x0, y0, x1, y1 = rel(b)
        d.rectangle((x0 - 3, y0 - 3, x1 + 3, y1 + 3), outline=YELLOW, width=3)
        r = 13
        cx, cy = x0 - 3, y0 - 3
        cx = max(cx, r + 1); cy = max(cy, r + 1)
        cx = min(cx, img.width - r - 1)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=YELLOW, outline=DARK, width=2)
        d.text((cx, cy), str(n), font=F_NUM, fill=DARK, anchor="mm")
    img.save(path, optimize=True)
    reg = _load()
    reg[fig] = {"fig": fig, "title": title, "module": module, "route": route, "role": ROLE.get(s.who, s.who or "Not signed in"),
                "callouts": [lbl for _, lbl in callouts], "masked": [lbl for _, lbl in masks], "caption": caption or title, "purpose": purpose,
                "note": note, "looking": looking, "click": click, "why": why, "size": [img.width, img.height]}
    json.dump(reg, open(REG, "w"), indent=1)
    page.set_viewport_size({"width": page.viewport_size["width"], "height": 860})
    return path
