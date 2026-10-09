"""Tiny client for the training finance-api (port 8787) and PostgREST (3998)."""
import json, urllib.request, urllib.error

REST = "http://127.0.0.1:3998"
API = "http://127.0.0.1:8787"
_ids = {}

def rest(path):
    return json.load(urllib.request.urlopen(f"{REST}/{path}"))

EMAIL = {"alex": "alex.admin", "dana": "dana.director", "fran": "fran.finance", "pat": "pat.payroll", "morgan": "morgan.pm",
         "sam": "sam.supervisor", "chris": "chris.accountant", "tom": "tom.welder", "olivia": "olivia.office", "casey": "casey.rigger",
         "jamie": "jamie.apprentice"}

def email(who):
    return who if "@" in who else f"{EMAIL[who]}@training.panalo.test"

def uid(who):
    e = email(who)
    if e not in _ids:
        _ids[e] = rest(f"training_profiles?select=id&email=eq.{e}")[0]["id"]
    return _ids[e]

class ApiError(Exception):
    pass

def call(who, action, **body):
    body["action"] = action
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "x-test-user": uid(who)})
    try:
        r = urllib.request.urlopen(req)
        return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise ApiError(f"{action} as {who}: {e.code} {e.read().decode()[:400]}")

def try_call(who, action, **body):
    try:
        return call(who, action, **body)
    except ApiError as e:
        return {"error": str(e)}

def acc(lst, code):
    return next(a["id"] for a in lst if a["code"] == code)
