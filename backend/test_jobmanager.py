"""JobManager persistence & recovery test (offline, fast).

Simulates:
 1. a job completing -> its result must be stored
 2. a 'crash' (new JobManager over the same store) with a stale 'running' row
    -> the stale job must be re-queued and executed (here: errors out fast)
 3. GET-equivalent (manager.get) after 'restart' must still serve the old
    result for the done job.
"""
from app.main import JobManager
from app.jobstore import JobStore
import pathlib
import tempfile

p = pathlib.Path(tempfile.gettempdir()) / "jm_test.sqlite"
if p.exists():
    p.unlink()

store = JobStore(p)


class TinyManager(JobManager):
    """Overrides _dispatch so no real pipelines run."""

    def _dispatch(self, kind, payload, progress):
        if kind == "boom":
            raise RuntimeError("intentional test failure")
        return {"echo": payload}


# 1) run a job to completion
m1 = TinyManager(1, store=store)
jid_done = m1.submit("resolve_city", {"x": 1})
import time
for _ in range(50):
    time.sleep(0.1)
    if m1.get(jid_done)["status"] == "done":
        break
assert m1.get(jid_done)["status"] == "done", "job did not finish"
assert m1.get(jid_done)["result"] == {"echo": {"x": 1}}
print("1. submit + persist + result: OK")

# 2) write a stale 'running' row (simulating a crash mid-job), then 'restart'
store.upsert("stalejob", "boom", '{"city_id":"y"}', "running", "loading", 0.4,
             "mid-flight", None, None, "2026-08-27T00:00:00+00:00",
             "2026-08-27T00:00:00+00:00")

# 'restart': fresh manager over the same store; requeues the stale job
m2 = TinyManager(1, store=store)
jid = "stalejob"
ok_requeued = False
for _ in range(50):
    time.sleep(0.1)
    st = m2.get(jid)
    if st and st["status"] in ("running", "error"):
        ok_requeued = True
        break
assert ok_requeued, "stale running job was not re-queued after restart"
for _ in range(50):
    time.sleep(0.1)
    if m2.get(jid)["status"] == "error":
        break
assert "intentional test failure" in (m2.get(jid)["error"] or "")
print("2. stale running job re-queued and executed after restart: OK")

# 3) the pre-restart done result is still retrievable from the new manager
assert m2.get(jid_done)["result"] == {"echo": {"x": 1}}
print("3. done-job result survives restart: OK")

store.close()
p.unlink()
print("JobManager persistence test PASS")
