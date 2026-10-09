"""Stage 5: lock July and August after review; dashboard-ready state."""
import sys, json
sys.path.insert(0, sys.path[0])
from api import *
per = call("fran", "periods_list")
fy = next(y for y in per["years"] if y["start"] == "2026-07-01")
for p in fy["periods"][:2]:
    call("fran", "period_set_status", id=p["id"], status="soft_locked", reason="Month reviewed and reconciled")
print("stage 5 ok")
# Older notifications read; leave only what is genuinely waiting.
import subprocess, shutil
shutil.copy("/tmp/claude-0/-home-claude-jaysonsugpatanjs-hub-github-io/bec2506f-192b-577d-8c27-2271b2dd611e/scratchpad/manual/train/notes.sql", "/tmp/notes.sql")
subprocess.run(["su", "postgres", "-c", "psql -d panalo_train -q -f /tmp/notes.sql"], check=True)
print("notifications tidied")
