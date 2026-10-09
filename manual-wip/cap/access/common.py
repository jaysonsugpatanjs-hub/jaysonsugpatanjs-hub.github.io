import os, sys, json
os.environ["PANALO_REST"] = "http://127.0.0.1:3991"; os.environ["PANALO_API"] = "http://127.0.0.1:8781"
M = "/tmp/claude-0/-home-claude-jaysonsugpatanjs-hub-github-io/bec2506f-192b-577d-8c27-2271b2dd611e/scratchpad/manual"
sys.path.insert(0, M)
from shotlib import *  # noqa
AREA = "access"
NEW = "demo.newstarter@training.panalo.test"
TEMP = "demo.temppass@training.panalo.test"
LEAVER = "demo.leaver@training.panalo.test"
def S(p, who, **kw):
    kw.setdefault("area", AREA)
    return Session(p, who, **kw)
