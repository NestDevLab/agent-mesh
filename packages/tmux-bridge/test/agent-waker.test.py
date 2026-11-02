#!/usr/bin/env python3
"""Hermetic pending-queue, dedupe, and fail-safe checks for agent-waker.py."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "agent-waker.py"
spec = importlib.util.spec_from_file_location("agent_waker", SCRIPT)
waker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waker)

SESSION = "00000000-0000-4000-8000-000000000001"


class AgentWakerTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "state.json"
        environment = patch.dict(os.environ, {"AGENT_RUNS_DIR": str(self.root / "runs")})
        environment.start()
        self.addCleanup(environment.stop)
        self.sent = []
        self.delivery_exit = 124
        deliver = patch.object(waker, "deliver", side_effect=self.fake_deliver)
        deliver.start()
        self.addCleanup(deliver.stop)

    def fake_deliver(self, agent, session, correlation, message, inbox_root):
        self.sent.append(message)
        return self.delivery_exit

    def tick(self, report=None, raw=None):
        body = raw if raw is not None else json.dumps(report)
        producer = [sys.executable, "-c", f"print({body!r})"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = waker.main(["run", "--job", "daily", "--session", SESSION, "--state", str(self.state),
                               "--", *producer])
        return code, json.loads(out.getvalue())

    def receipts(self):
        return [json.loads(line)["outcome"] for path in sorted((self.root / "runs").glob("*.jsonl"))
                for line in path.read_text().splitlines()]

    def test_nothing_new_does_not_wake(self):
        code, result = self.tick({"new": [], "errors": []})
        self.assertEqual((code, result["outcome"], self.sent), (0, "noop", []))
        self.assertEqual(self.receipts(), ["noop"])

    def test_new_item_wakes_once_and_clears_pending(self):
        item = {"source": "email:work", "id": "m1"}
        code, result = self.tick({"new": [item], "errors": []})
        self.assertEqual((code, result["outcome"], len(self.sent)), (0, "acted", 1))
        self.assertIn('"id": "m1"', self.sent[0])
        self.assertEqual(json.loads(self.state.read_text())["pending"], [])
        self.tick({"new": [], "errors": []})
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.receipts(), ["acted", "noop"])

    def test_refused_delivery_keeps_items_for_next_run(self):
        self.delivery_exit = 78
        code, result = self.tick({"new": [{"id": "m1"}], "errors": []})
        self.assertEqual((code, result["outcome"]), (3, "blocked"))
        self.delivery_exit = 0
        code, result = self.tick({"new": [{"id": "m2"}, {"id": "m1"}], "errors": []})
        self.assertEqual((result["outcome"], result["pending"]), ("acted", 2))
        self.assertIn('"id": "m1"', self.sent[-1])
        self.assertIn('"id": "m2"', self.sent[-1])

    def test_same_error_wakes_only_once_until_it_changes(self):
        error = {"source": "linkedin", "error": "login redirect"}
        self.tick({"new": [], "errors": [error]})
        self.tick({"new": [], "errors": [error]})
        self.assertEqual(len(self.sent), 1)
        self.tick({"new": [], "errors": []})
        self.tick({"new": [], "errors": [error]})
        self.assertEqual(len(self.sent), 2)

    def test_broken_producer_is_delivered_not_dropped(self):
        code, result = self.tick(raw="not json")
        self.assertEqual((code, result["outcome"]), (0, "acted"))
        self.assertIn("producer", self.sent[0])

    def test_unreadable_state_wakes_and_resets(self):
        self.state.write_text("{broken")
        code, result = self.tick({"new": [], "errors": []})
        self.assertEqual(result["outcome"], "acted")
        self.assertIn("waker-state", self.sent[0])
        self.assertEqual(json.loads(self.state.read_text())["pending"], [])


if __name__ == "__main__":
    unittest.main()
