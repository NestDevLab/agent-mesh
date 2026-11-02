#!/usr/bin/env python3
"""Hermetic receipt and missed-run checks for agent-run-receipt.py."""
import contextlib
import importlib.util
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "agent-run-receipt.py"
spec = importlib.util.spec_from_file_location("agent_run_receipt", SCRIPT)
receipts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipts)

NOW = "2026-11-02T12:00:00Z"


def epoch(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()


class RunReceiptTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        environment = patch.dict(os.environ, {"AGENT_RUNS_DIR": str(self.root / "runs")})
        environment.start()
        self.addCleanup(environment.stop)

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = receipts.main(list(argv))
        return code, [json.loads(line) for line in out.getvalue().splitlines()]

    def watch(self, *jobs):
        config = self.root / "watch.json"
        config.write_text(json.dumps({"jobs": list(jobs)}))
        return str(config)

    def check(self, *jobs, extra=()):
        return self.run_main("check", "--config", self.watch(*jobs), "--now", NOW, *extra)

    def test_record_appends_to_daily_file(self):
        for outcome in ("acted", "noop"):
            self.run_main("record", "--job", "daily", "--outcome", outcome, "--trigger", "cron",
                          "--session", "s-1", "--ended-at", "2026-11-02T09:00:00Z")
        lines = (self.root / "runs" / "2026-11-02.jsonl").read_text().splitlines()
        self.assertEqual([json.loads(line)["outcome"] for line in lines], ["acted", "noop"])
        self.assertEqual(json.loads(lines[0])["schema"], "agent-mesh.run-receipt.v1")

    def test_recent_receipt_is_ok_and_old_one_is_missed(self):
        self.run_main("record", "--job", "daily", "--outcome", "acted", "--ended-at", "2026-11-01T20:00:00Z")
        code, [result] = self.check({"name": "daily", "maxAgeHours": 26})
        self.assertEqual((code, result["status"], result["ageHours"]), (0, "ok", 16.0))
        code, [result] = self.check({"name": "daily", "maxAgeHours": 12})
        self.assertEqual((code, result["status"]), (2, "missed"))

    def test_job_without_evidence_is_never(self):
        code, [result] = self.check({"name": "nightly-audit", "maxAgeHours": 26})
        self.assertEqual((code, result["status"]), (2, "never"))

    def test_latest_failed_receipt_is_failed(self):
        self.run_main("record", "--job", "daily", "--outcome", "acted", "--ended-at", "2026-11-02T08:00:00Z")
        self.run_main("record", "--job", "daily", "--outcome", "failed", "--ended-at", "2026-11-02T10:00:00Z")
        _, [result] = self.check({"name": "daily", "maxAgeHours": 26})
        self.assertEqual(result["status"], "failed")

    def test_silent_output_file_is_missed(self):
        reports = self.root / "audit"
        reports.mkdir()
        report = reports / "audit.json"
        report.write_text("{}")
        os.utime(report, (epoch("2026-10-13T11:10:00Z"),) * 2)
        code, [result] = self.check({"name": "git-audit", "maxAgeHours": 26, "path": str(reports / "*.json")})
        self.assertEqual((code, result["status"], result["lastRunAt"]), (2, "missed", "2026-10-13T11:10:00Z"))

    def test_newest_json_must_match_expected_fields(self):
        guard = self.root / "guard"
        guard.mkdir()
        for name, status, at in (("a.json", "guarded", "2026-11-02T09:00:00Z"),
                                 ("b.json", "unguarded", "2026-11-02T10:00:00Z")):
            (guard / name).write_text(json.dumps({"status": status, "setting": {"autoContinueEnabled": False}}))
            os.utime(guard / name, (epoch(at),) * 2)
        job = {"name": "reset-guard", "maxAgeHours": 170, "path": str(guard / "*.json"),
               "expect": {"status": "guarded", "setting.autoContinueEnabled": False}}
        code, [result] = self.check(job)
        self.assertEqual((code, result["status"], result["mismatch"]), (2, "unexpected", {"status": "unguarded"}))

    def test_alerts_only_hides_healthy_jobs(self):
        self.run_main("record", "--job", "daily", "--outcome", "noop", "--ended-at", "2026-11-02T11:00:00Z")
        code, results = self.check({"name": "daily", "maxAgeHours": 26},
                                   {"name": "nightly-audit", "maxAgeHours": 26}, extra=("--alerts-only",))
        self.assertEqual((code, [r["job"] for r in results]), (2, ["nightly-audit"]))

    def test_invalid_watch_list_exits_1(self):
        code, results = self.check({"maxAgeHours": 1})
        self.assertEqual((code, results), (1, []))


if __name__ == "__main__":
    unittest.main()
