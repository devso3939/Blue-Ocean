"""Quick roundtrip test for JobStore (run from backend/)."""
import pathlib
import tempfile

from app.jobstore import JobStore

p = pathlib.Path(tempfile.gettempdir()) / "jt_test.sqlite"
if p.exists():
    p.unlink()

s = JobStore(p)
s.upsert("j1", "analyze", '{"city_id":"x"}', "queued", "queued", 0.0, None, None, None,
         "2026-08-27T00:00:00+00:00", "2026-08-27T00:00:00+00:00")
s.update("j1", status="done", progress=1.0, result='{"ok": 1}')
rows = s.load_all()
assert rows[0]["job_id"] == "j1"
assert rows[0]["status"] == "done"
assert rows[0]["result"] == '{"ok": 1}'
# ISO string comparison: an old cutoff must NOT delete a newer row
s.delete_older_than("2026-08-26T00:00:00+00:00")
assert len(s.load_all()) == 1
# a future cutoff deletes everything
s.delete_older_than("2027-01-01T00:00:00+00:00")
assert len(s.load_all()) == 0
s.close()
p.unlink()
print("JobStore roundtrip OK")
