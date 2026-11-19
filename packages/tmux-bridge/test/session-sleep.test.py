import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid


COMMAND = Path(__file__).resolve().parents[1] / "bin" / "session-sleep.py"
CHECKPOINT = {"work": ["Review"], "decisions": [], "nextSteps": ["Check"], "references": []}


class ManualSleep(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cwd = self.directory.name
        self.env = dict(os.environ, XDG_STATE_HOME=self.cwd)
        self.source_id = str(uuid.uuid4())

    def invoke(self, *args, checkpoint=None, ok=True):
        result = subprocess.run(
            [sys.executable, COMMAND, *args],
            input=json.dumps(checkpoint) if checkpoint is not None else "",
            text=True,
            capture_output=True,
            env=self.env,
            check=False,
        )
        if not ok:
            self.assertEqual(result.returncode, 2, result)
            return result.stderr
        self.assertEqual(result.returncode, 0, result)
        return json.loads(result.stdout)

    def prepare(self, runtime, mode="sleep"):
        return self.invoke(
            "prepare", "--source", f"{runtime}:{self.source_id}", "--cwd", self.cwd,
            "--mode", mode, checkpoint=CHECKPOINT,
        )

    def resume(self, operation, runtime, identifier, *, surface="canary-pane", token=None, ok=True):
        record = self.invoke("read", operation)
        return self.invoke(
            "resume", operation, "--session", f"{runtime}:{identifier}", "--surface", surface,
            "--cwd", self.cwd, "--token", token or record["resumeToken"],
            "--evidence", "synthetic native observation", ok=ok,
        )

    def test_codex_requires_new_session_and_link_before_archive(self):
        prepared = self.prepare("codex")
        operation = prepared["operation"]
        self.invoke("begin", operation, "--surface", "canary-pane")
        self.assertIn("different native thread", self.resume(operation, "codex", self.source_id, ok=False))
        self.invoke("archive", operation, "--evidence", "out of order", ok=False)
        target = str(uuid.uuid4())
        self.resume(operation, "codex", target)
        self.invoke("archive", operation, "--evidence", "still out of order", ok=False)
        link = self.invoke("link", operation, "--evidence", "read back predecessor's final reply")
        self.assertEqual(link["receipt"]["link"], f"codex://threads/{target}")
        self.invoke("archive", operation, "--evidence", "observed native archive")
        state = self.invoke("read", operation)
        self.assertEqual(state["checkpoint"], CHECKPOINT)
        self.assertEqual(state["receipts"][2]["session"], f"codex:{target}")
        self.assertEqual([event["outcome"] for event in state["receipts"]],
                         ["prepared", "started", "resumed", "linked", "archived"])
        self.assertEqual(stat.S_IMODE(Path(prepared["stateFile"]).stat().st_mode), 0o600)

    def test_claude_nap_correlates_surface_and_readback(self):
        operation = self.prepare("claude", "nap")["operation"]
        self.invoke("begin", operation, "--surface", "canary-pane")
        target = str(uuid.uuid4())
        self.resume(operation, "claude", target, surface="other-pane", ok=False)
        self.resume(operation, "claude", target, token="wrong", ok=False)
        self.resume(operation, "claude", target)
        self.invoke("link", operation, "--evidence", "inapplicable", ok=False)
        self.assertEqual(self.invoke("read", operation)["mode"], "nap")
        self.prepare("claude", "nap")

    def test_ambiguous_attempt_allows_readback_but_blocks_repeat_launch(self):
        operation = self.prepare("codex")["operation"]
        self.invoke("begin", operation, "--surface", "canary-pane")
        self.invoke("uncertain", operation, "--evidence", "initial readback unavailable")
        self.invoke("begin", operation, "--surface", "canary-pane", ok=False)
        error = self.invoke(
            "prepare", "--source", f"codex:{self.source_id}", "--cwd", self.cwd,
            checkpoint=CHECKPOINT, ok=False,
        )
        self.assertIn(operation, error)
        self.resume(operation, "codex", str(uuid.uuid4()))

    def test_rejects_untrusted_checkpoint_shapes_and_file_types(self):
        self.invoke("prepare", "--source", "codex:bad", "--cwd", self.cwd, checkpoint=CHECKPOINT, ok=False)
        self.invoke(
            "prepare", "--source", f"codex:{self.source_id}", "--cwd", self.cwd,
            checkpoint={"work": ["missing fields"]}, ok=False,
        )
        self.assertEqual(list((Path(self.cwd) / "agent-mesh" / "manual-sleep").glob("*.json")), [])
        prepared = self.prepare("codex")
        path = Path(prepared["stateFile"])
        path.chmod(0o644)
        self.invoke("read", prepared["operation"], ok=False)


if __name__ == "__main__":
    unittest.main()
