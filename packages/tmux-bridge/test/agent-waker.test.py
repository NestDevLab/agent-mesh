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
from types import SimpleNamespace
from unittest.mock import patch, Mock

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "agent-waker.py"
spec = importlib.util.spec_from_file_location("agent_waker", SCRIPT)
waker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waker)

SESSION = "00000000-0000-4000-8000-000000000001"


class ResumeFlagTest(unittest.TestCase):
    def test_native_resume_is_opt_in_and_codex_only(self):
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout='{"status":"queued"}')) as run:
            waker.deliver('codex', SESSION, 'test', 'message', None, True, resume=True)
            self.assertIn('--resume', run.call_args[0][0])
            waker.deliver('codex', SESSION, 'test', 'message', None, True)
            self.assertNotIn('--resume', run.call_args[0][0])
            with self.assertRaises(ValueError):
                waker.deliver('claude', SESSION, 'test', 'message', None, resume=True)


class NativeReceiptTest(unittest.TestCase):
    def test_zero_exit_holds_and_invalid_receipts_keep_durable_pending(self):
        for receipt in ({'status': 'queued', 'held': True}, {'status': 'refused', 'held': True},
                        {'status': 'refused'}, None):
            with self.subTest(receipt=receipt), tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / 'state.json'
                args = SimpleNamespace(state=str(state), job='observer', producer=['fixture'], producer_timeout=1,
                                       agent='codex', session=SESSION, managed_inbox_root=None,
                                       delivery_only=True, resume=True)
                with patch.object(waker, 'run_producer', return_value=([{'event': 'one'}], [])), \
                     patch.object(waker, 'record'), \
                     patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(receipt))), \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(waker.run(args), 3)
                saved = json.loads(state.read_text())
                self.assertEqual(len(saved['pending']), 1)
                self.assertNotIn('lastDelivery', saved)

    def test_queued_receipt_requires_every_recipient_and_correlation_binding(self):
        base = {'status': 'queued', 'agent': 'codex', 'sessionId': SESSION, 'correlationId': 'flight'}
        for key in ('agent', 'sessionId', 'correlationId'):
            for invalid in ({k: v for k, v in base.items() if k != key}, {**base, key: 'wrong'}):
                with self.subTest(key=key, invalid=invalid), patch.object(waker.subprocess, 'run',
                        return_value=Mock(returncode=0, stdout=json.dumps(invalid))):
                    self.assertEqual(waker.deliver('codex', SESSION, 'flight', 'message', None, True), 78)
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(base))):
            self.assertEqual(waker.deliver('codex', SESSION, 'flight', 'message', None, True), 0)

    def test_result_mode_preserves_plain_result_exit_contract(self):
        with patch.object(waker.subprocess, 'run', return_value=Mock(returncode=124, stdout='ordinary result')):
            self.assertEqual(waker.deliver('codex', SESSION, 'result', 'message', None), 124)
            self.assertEqual(waker.deliver('codex', SESSION, 'delivery', 'message', None, True), 78)


class InFlightTest(unittest.TestCase):
    def test_hold_restart_reuses_exact_envelope_and_delivered_ack_only_its_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state.json'
            # Existing pre-flight state upgrades without losing pending items.
            state.write_text(json.dumps({'schema': waker.SCHEMA, 'pending': [], 'errorSignature': None}))
            args = SimpleNamespace(state=str(state), job='observer', producer=['fixture'], producer_timeout=1,
                                   agent='codex', session=SESSION, managed_inbox_root=None,
                                   delivery_only=True, resume=True)
            calls = []
            def native(command, **kwargs):
                values = {command[i]: command[i+1] for i in range(len(command)-1) if command[i] in
                          ('--correlation-id', '--message', '--agent', '--session')}
                calls.append(values)
                return Mock(returncode=0, stdout=json.dumps({'held': True,
                    'status': 'delivered' if len(calls) == 3 else 'queued',
                    'agent': values['--agent'], 'sessionId': values['--session'],
                    'correlationId': values['--correlation-id']}))
            with patch.object(waker, 'record'), patch.object(waker.subprocess, 'run', side_effect=native), \
                 contextlib.redirect_stdout(io.StringIO()):
                for item in ({'id': 'first'}, {'id': 'later'}, {'id': 'later'}):
                    with patch.object(waker, 'run_producer', return_value=([item], [])):
                        code = waker.run(args)  # reloads disk each call, as after restart
            self.assertEqual(code, 0)
            self.assertEqual(calls[0], calls[1])
            self.assertEqual(calls[1], calls[2])
            saved = json.loads(state.read_text())
            self.assertEqual(saved['lastDelivery']['itemKeys'], [waker.item_key({'id': 'first'})])
            self.assertEqual([entry['item'] for entry in saved['pending']], [{'id': 'later'}])
            self.assertNotIn('inFlight', saved)

    def test_delivered_receipt_must_match_frozen_recipient_and_correlation(self):
        base = {'held': True, 'status': 'delivered', 'agent': 'codex', 'sessionId': SESSION, 'correlationId': 'flight'}
        for key in ('agent', 'sessionId', 'correlationId'):
            with self.subTest(key=key), patch.object(waker.subprocess, 'run',
                    return_value=Mock(returncode=0, stdout=json.dumps({**base, key: 'wrong'}))):
                self.assertEqual(waker.deliver('codex', SESSION, 'flight', 'message', None, True), 78)


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

    def fake_deliver(self, agent, session, correlation, message, inbox_root, delivery_only=False):
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
        self.assertTrue(json.loads(self.state.read_text())["lastDelivery"]["itemKeys"])
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
        self.assertNotIn('"id": "m2"', self.sent[-1])
        self.assertEqual(len(json.loads(self.state.read_text())["pending"]), 1)
        self.tick({"new": [], "errors": []})
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
