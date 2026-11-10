"""Exercise live group import with an isolated graph and real role guard."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

BIN = Path(__file__).resolve().parents[1] / "bin"
SESSION = "codex:11111111-1111-4111-8111-111111111111"
SECOND = "codex:22222222-2222-4222-8222-222222222222"


@unittest.skipUnless(sys.platform == "linux", "Linux parent-death protection required")
class LiveImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.graph = self.root / "graph"
        self.groups = self.root / "groups"
        self.env = {**os.environ, "XDG_STATE_HOME": str(self.root / "xdg"),
                    "PYTHONDONTWRITEBYTECODE": "1"}
        self.graph_call("add", "--agent", "codex", "--runtime-uuid", SESSION.split(":")[1],
                        "--tmux-target", "fixture")
        self.graph_call("migrate", "--apply")
        self.graph_call("link", "open", "--agent", "codex", "--runtime-uuid", SESSION.split(":")[1],
                        "--ref", "group:fixture", "--role", "discusses")
        claim = self.graph_call("role", "claim", "--session", SESSION, "--role", "migration",
                                "--project", "fixture")["claim"]["id"]
        self.base = ["--graph-state", str(self.graph), "--state", str(self.groups),
                     "--session", SESSION, "--role", "migration", "--project", "fixture",
                     "--claim-id", claim, "--source", "fixture", "--include-group", "group:fixture"]

    def graph_call(self, *args, binary=BIN / "mesh-graph.mjs"):
        result = subprocess.run(["node", str(binary), "--state", str(self.graph), *args, "--json"],
                                env=self.env, text=True, capture_output=True, timeout=10, check=True)
        return json.loads(result.stdout)

    def live(self, *extra, binary=BIN / "mesh-group-import-live.py", success=True):
        result = subprocess.run([sys.executable, str(binary), *self.base, *extra],
                                env=self.env, text=True, capture_output=True, timeout=20)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result.stderr

    def test_preview_rejects_drift_then_imports_exact_current_graph(self):
        preview = self.live()
        self.assertEqual(preview["status"], "ready")
        self.assertFalse(self.groups.exists())
        self.graph_call("add", "--agent", "codex", "--runtime-uuid", SECOND.split(":")[1],
                        "--tmux-target", "second")
        self.graph_call("link", "open", "--agent", "codex", "--runtime-uuid", SECOND.split(":")[1],
                        "--ref", "group:fixture", "--role", "discusses")
        self.assertIn("digest", self.live("--apply", "--plan-digest", preview["plan_digest"], success=False))
        self.assertFalse(self.groups.exists())
        current = self.live()
        imported = self.live("--apply", "--plan-digest", current["plan_digest"])
        self.assertEqual(imported["status"], "imported")
        self.assertEqual(len(imported["groups"][0]["members"]), 2)
        self.assertEqual(self.live("--apply", "--plan-digest", current["plan_digest"])["status"],
                         "already_imported")

    def test_direct_worker_and_invalid_claim_fail_before_store_access(self):
        self.assertIn("guard", self.live("--worker", success=False))
        invalid = list(self.base)
        invalid[invalid.index("--claim-id") + 1] = "invalid"
        result = subprocess.run([sys.executable, str(BIN / "mesh-group-import-live.py"), *invalid],
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.groups.exists())

    def test_parent_death_stops_the_import_writer(self):
        preview = self.live()
        copied = self.root / "bin"
        shutil.copytree(BIN, copied, ignore=shutil.ignore_patterns("__pycache__"))
        store = copied / "mesh_group_store.py"
        source = store.read_text()
        marker = '        """Preview, or atomically import, a reviewed legacy snapshot without writing the graph."""'
        injection = marker + """
        if os.environ.get("TEST_IMPORT_SIGNAL"):
            import time
            Path(os.environ["TEST_IMPORT_SIGNAL"]).write_text("armed")
            time.sleep(2.5)
            Path(os.environ["TEST_IMPORT_LATE"]).write_text("late")
"""
        self.assertIn(marker, source)
        store.write_text(source.replace(marker, injection, 1))
        env = {**self.env, "TEST_IMPORT_SIGNAL": str(self.root / "armed"),
               "TEST_IMPORT_LATE": str(self.root / "late")}
        proc = subprocess.Popen([sys.executable, str(copied / "mesh-group-import-live.py"),
                                 *self.base, "--apply", "--plan-digest", preview["plan_digest"]],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "armed").exists() and time.monotonic() < deadline:
                if proc.poll() is not None:
                    self.fail(f"import exited before the guard was armed: {proc.communicate()}")
                time.sleep(0.02)
            self.assertTrue((self.root / "armed").exists())
            proof = json.loads((self.graph / "graph.lock" / "comms-guard.json").read_text())
            os.kill(proof["pid"], 9)
            old = time.time() - 65
            os.utime(self.graph / "graph.lock", (old, old))
            self.graph_call("link", "open", "--agent", "codex", "--runtime-uuid", SESSION.split(":")[1],
                            "--ref", "group:concurrent", "--role", "discusses")
            proc.communicate(timeout=8)
            time.sleep(3)
            self.assertFalse((self.root / "late").exists())
            self.assertFalse(self.groups.exists())
            self.assertNotEqual(proc.returncode, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=5)

    def test_parent_death_before_protection_is_armed_is_rejected(self):
        child = """
import importlib.util, os, pathlib, sys, time
binary, graph, go, rejected = sys.argv[1:]
while not pathlib.Path(go).exists():
    time.sleep(.01)
sys.path.insert(0, str(pathlib.Path(binary).parent))
spec = importlib.util.spec_from_file_location("live_import", binary)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    module.arm_parent_death_guard(pathlib.Path(graph))
except ValueError:
    pathlib.Path(rejected).write_text("rejected")
"""
        parent = """
import os, pathlib, subprocess, sys, time
binary, graph, root, child = sys.argv[1:]
root = pathlib.Path(root)
env = {**os.environ, "PROJECT_DIRECTOR_GUARD_PID": str(os.getpid()),
       "PROJECT_DIRECTOR_GUARD_CLAIM": "fixture", "MESH_COMMS_GUARD_TOKEN": "fixture"}
proc = subprocess.Popen([sys.executable, "-c", child, binary, graph, str(root/"go"),
                         str(root/"rejected")], env=env, start_new_session=True,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(root/"child").write_text(str(proc.pid))
time.sleep(20)
"""
        proc = subprocess.Popen([sys.executable, "-c", parent, str(BIN / "mesh-group-import-live.py"),
                                 str(self.graph), str(self.root), child], env=self.env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / "child").exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue((self.root / "child").exists())
            proc.kill()
            proc.wait(timeout=5)
            (self.root / "go").write_text("go")
            deadline = time.monotonic() + 5
            while not (self.root / "rejected").exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue((self.root / "rejected").exists())
            self.assertFalse(self.groups.exists())
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
