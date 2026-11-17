#!/usr/bin/env python3
"""Run a cheap producer and wake the owning session only when it reports something new.

The producer prints one JSON object {"new": [...], "errors": [...]}; it owns its own cursor, so
every item it returns is new. Undelivered items stay pending in the waker state and are retried, so
a refused delivery never drops them. Errors wake the session once per distinct error set.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
import stat
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import uuid
from typing import Any

BIN = Path(__file__).resolve().parent
SCHEMA = "agent-mesh.waker-state.v1"
# agent-native-call exit codes that mean the turn was queued: result seen, empty result, wait timed out.
QUEUED = {0, 65, 124}
# The comms row for this correlation is terminal and undelivered; retrying it can never succeed.
DEAD_FLIGHT = 79
MAX_LISTED = 40
MAX_LINE = 400


def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(base) / "agent-waker"


def item_key(item: Any) -> str:
    return hashlib.sha256(json.dumps(item, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def error_signature(errors: list[Any]) -> str | None:
    if not errors:
        return None
    canonical = sorted(json.dumps(error, sort_keys=True, ensure_ascii=False) for error in errors)
    return hashlib.sha256("\n".join(canonical).encode()).hexdigest()[:16]


def load_state(path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    empty = {"schema": SCHEMA, "pending": [], "errorSignature": None}
    if not path.exists():
        return empty, []
    try:
        state = json.loads(path.read_text())
        if not isinstance(state.get("pending"), list):
            raise ValueError("pending is not a list")
        return state, []
    except (OSError, ValueError) as error:
        return empty, [{"source": "waker-state", "error": f"unreadable state reset: {error}"}]


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".waker-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def run_producer(command: list[str], timeout: int) -> tuple[list[Any], list[Any]]:
    try:
        done = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return [], [{"source": "producer", "error": f"{type(error).__name__}: {error}"}]
    try:
        report = json.loads(done.stdout)
        new, errors = report["new"], report.get("errors") or []
        if not isinstance(new, list) or not isinstance(errors, list):
            raise ValueError("new/errors must be lists")
    except (ValueError, KeyError, TypeError) as error:
        tail = (done.stderr or done.stdout).strip()[-300:]
        return [], [{"source": "producer", "error": f"exit {done.returncode}, unusable report ({error}): {tail}"}]
    return new, errors


def compose(job: str, pending: list[dict[str, Any]], errors: list[Any]) -> str:
    lines = [f"agent-waker {job}: {min(len(pending), MAX_LISTED)} new item(s), {len(errors)} source error(s). "
             "Act on these; the waker already advanced the cursor and will not resend them."]
    for entry in pending[:MAX_LISTED]:
        lines.append("NEW " + json.dumps(entry["item"], ensure_ascii=False)[:MAX_LINE])
    if len(pending) > MAX_LISTED:
        lines.append(f"... {len(pending) - MAX_LISTED} more stay queued for the next wake.")
    for error in errors:
        lines.append("ERROR " + json.dumps(error, ensure_ascii=False)[:MAX_LINE])
    return "\n".join(lines)


def deliver(agent: str, session: str, correlation: str, message: str, inbox_root: str | None, delivery_only: bool = False, resume: bool = False, message_stdin: bool = False, receipt_out: dict | None = None, cloud_profile: str | None = None, cloud_scope: str | None = None) -> int:
    command = ["node", str(BIN / "agent-native-call.mjs"), "--agent", agent, "--session", session,
               "--correlation-id", correlation, "--timeout", "5"]
    command += ["--message-stdin"] if message_stdin else ["--message", message]
    if cloud_profile or cloud_scope:
        if not (cloud_profile and cloud_scope and agent == "claude" and delivery_only and message_stdin and not resume and not inbox_root):
            raise ValueError("invalid cloud delivery options")
        command += ["--cloud", "--cloud-profile", cloud_profile, "--cloud-scope", cloud_scope]
    if resume:
        if agent != "codex":
            raise ValueError("waker resume is supported only for Codex")
        command += ["--resume"]
    elif message_stdin and agent == "codex":
        command += ["--no-resume"]
    if delivery_only:
        command += ["--delivery-only"]
    if inbox_root:
        command += ["--managed-inbox-root", inbox_root]
    result = subprocess.run(command, text=True, capture_output=True, **({"input": message} if message_stdin else {}))
    try:
        receipt = json.loads(result.stdout)
    except (ValueError, TypeError):
        receipt = None
    bound = (isinstance(receipt, dict) and receipt.get("agent") == agent and
             receipt.get("sessionId") == session and receipt.get("correlationId") == correlation)
    if cloud_profile and isinstance(receipt, dict) and receipt.get("status") == "queued" and (receipt.get("transport") != "claude-cloud" or receipt.get("readBack") is not False):
        return 78
    if delivery_only and isinstance(receipt, dict) and receipt.get("status") == "queued" and not bound:
        return 78
    # A comms hold can exit zero: process success is not native queue acceptance.
    if isinstance(receipt, dict) and receipt.get("held") is True:
        # The gate's delivered duplicate is a receipt for this exact frozen flight.
        if (result.returncode == 0 and receipt.get("status") == "delivered" and
                receipt.get("agent") == agent and receipt.get("sessionId") == session and
                receipt.get("correlationId") == correlation):
            return 0
        if (receipt.get("status") in ("expired", "refused") and receipt.get("agent") == agent and
                receipt.get("sessionId") == session and receipt.get("correlationId") == correlation):
            return DEAD_FLIGHT
        return 78
    if delivery_only and (not isinstance(receipt, dict) or receipt.get("status") != "queued"):
        return 78
    if delivery_only and receipt_out is not None and result.returncode == 0 and bound:
        native_id = receipt.get('nativeQueueId')
        if native_id is not None:
            if agent != 'codex' or not isinstance(native_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', native_id):
                return 78
            receipt_out['nativeQueueId'] = native_id
    return result.returncode


def record(job: str, outcome: str, session: str, note: str) -> None:
    subprocess.run([sys.executable, "-I", str(BIN / "agent-run-receipt.py"), "record", "--job", job,
                    "--outcome", outcome, "--trigger", "timer", "--session", session, "--note", note],
                   capture_output=True)


def channel_call(args: argparse.Namespace, operation: str, *options: str) -> dict[str, Any]:
    command = ['node', str(BIN / 'mesh-graph.mjs')]
    if args.graph_state:
        command += ['--state', args.graph_state]
    arguments = list(options)
    payload = None
    if '--input' in arguments:
        index = arguments.index('--input') + 1
        payload = arguments[index]
        arguments[index] = '-'
    command += ['channel', operation, '--name', args.channel, *arguments]
    result = subprocess.run(command, input=payload, text=True, capture_output=True, timeout=30, check=True)
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or not isinstance(value.get('channel'), dict):
        raise ValueError('invalid channel response')
    return value['channel']


def observe_claude_channel_delivery(args: argparse.Namespace, message_id: str, recovery: bool = False) -> None:
    command = ['node', str(BIN / 'mesh-graph.mjs')]
    if args.graph_state:
        command += ['--state', args.graph_state]
    operation = 'recover-claude-delivery' if recovery else 'observe-claude-delivery'
    command += ['channel', operation, '--name', args.channel, '--id', message_id]
    result = subprocess.run(command, text=True, capture_output=True, timeout=30, check=True)
    value = json.loads(result.stdout)
    allowed = ('accepted', 'observed') if recovery else ('observed',)
    if not isinstance(value, dict) or value.get('status') not in allowed or value.get('channel') != args.channel or value.get('messageId') != message_id:
        raise ValueError('invalid delivery observation')


def preflight_codex_channel_wake(item: dict[str, Any], channel: dict[str, Any]) -> bool:
    session = channel['session']
    if not session.startswith('codex:'):
        raise ValueError('invalid Codex wake target')
    command = ['node', str(BIN / 'codex-wake-evidence.mjs'), '--preflight', '--thread', session[6:],
               '--queue-id', item['nativeQueueId'], '--correlation', item['id']]
    result = subprocess.run(command, text=True, capture_output=True, timeout=20, check=True)
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get('schema') != 'agent-mesh.wake-preflight.v1' or value.get('session') != session or value.get('queueId') != item['nativeQueueId'] or value.get('correlation') != item['id'] or value.get('status') not in ('ready', 'not-ready'):
        raise ValueError('invalid wake preflight')
    return value['status'] == 'ready'


def start_codex_channel_wake(args: argparse.Namespace, item: dict[str, Any], channel: dict[str, Any]) -> str:
    session = channel['session']
    if not session.startswith('codex:') or not args.graph_state or not os.path.isabs(args.graph_state) or not os.path.isabs(args.wake_evidence_root):
        raise ValueError('explicit private wake and graph roots required')
    command = ['node', str(BIN / 'codex-wake-evidence.mjs'), '--apply', '--thread', session[6:],
               '--queue-id', item['nativeQueueId'], '--correlation', item['id'], '--channel', args.channel,
               '--generation', str(channel['generation']), '--evidence-root', args.wake_evidence_root,
               '--graph-state', args.graph_state]
    result = subprocess.run(command, text=True, capture_output=True, timeout=45, check=True)
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get('schema') != 'agent-mesh.wake-record.v1' or value.get('session') != session or value.get('settled') is not True or not re.fullmatch(r'codex-wake:[a-f0-9]{64}', str(value.get('evidence', ''))):
        raise ValueError('wake proof not verified')
    return value['evidence']


def cloud_target(target: str, root: str | None) -> tuple[str, str, str]:
    match = re.fullmatch(r'claude-cloud:([a-z][a-z0-9-]{0,63}):((?:session|cse)_[A-Za-z0-9]{1,128})', target)
    if not match or not root:
        raise ValueError('unsupported cloud recipient')
    directory = Path(root)
    if not directory.is_absolute() or directory.resolve() != directory:
        raise ValueError('invalid cloud profile root')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('insecure cloud profile root')
    scope, session = match.groups()
    profile = directory / f'{scope}.json'
    info = profile.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('insecure cloud profile')
    return session, str(profile), scope


def run_channel(args: argparse.Namespace) -> int:
    path = Path(args.state) if args.state else state_dir() / f'{args.job}.json'
    with locked(path) as acquired:
        if not acquired:
            print(json.dumps({'job': args.job, 'outcome': 'noop', 'reason': 'previous run still active'}))
            return 0
        state, state_errors = load_state(path)
        if state_errors:
            print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'unreadable waker state'}))
            return 3
        new, errors = run_producer(args.producer, args.producer_timeout)
        errors = state_errors + errors
        known = {entry['key'] for entry in state['pending']}
        for item in new:
            key = item_key(item)
            if key not in known:
                known.add(key)
                state['pending'].append({'key': key, 'item': item})
        signature = error_signature(errors)
        wake_errors = errors if signature and signature != state.get('errorSignature') else []
        if not errors:
            state['errorSignature'] = None
        flight = state.get('inFlight')
        recipient = {'channel': args.channel}
        if flight and flight.get('recipient') != recipient:
            print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'in-flight recipient changed'}))
            return 3
        if not flight and (state['pending'] or wake_errors):
            flight = {'correlationId': f'waker-{uuid.uuid4()}', 'recipient': recipient,
                      'message': compose(args.job, state['pending'], wake_errors),
                      'itemKeys': [entry['key'] for entry in state['pending'][:MAX_LISTED]], 'errorSignature': signature}
            state['inFlight'] = flight
        save_state(path, state)
        try:
            if flight:
                channel_call(args, 'enqueue', '--id', flight['correlationId'], '--input', flight['message'])
                accepted = set(flight['itemKeys'])
                state['pending'] = [entry for entry in state['pending'] if entry['key'] not in accepted]
                state['lastDelivery'] = {'correlationId': flight['correlationId'], 'at': time.time(),
                                         'itemKeys': flight['itemKeys'], 'status': 'channel-queued'}
                if flight['errorSignature']:
                    state['errorSignature'] = flight['errorSignature']
                state.pop('inFlight', None)
                save_state(path, state)
            channel = channel_call(args, 'get')
            if channel.get('phase') not in ('active', 'draining'):
                print(json.dumps({'job': args.job, 'outcome': 'queued', 'reason': 'handover'}))
                return 0
            inflight = next((item for item in channel['queue'] if item.get('state') == 'inflight'), None)
            if inflight and channel.get('session', '').startswith('claude:'):
                observe_claude_channel_delivery(args, inflight['id'], recovery=True)
                print(json.dumps({'job': args.job, 'outcome': 'acted', 'reason': 'delivery recovered'}))
                return 0
            if inflight:
                print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'unresolved delivery'}))
                return 3
            if channel.get('phase') == 'draining' and channel.get('session', '').startswith('claude:'):
                backlog = channel.get('handover', {}).get('backlog', [])
                awaiting = next((item for item in channel['queue'] if item.get('id') in backlog and item.get('state') == 'accepted'), None)
                if awaiting:
                    observe_claude_channel_delivery(args, awaiting['id'])
                    print(json.dumps({'job': args.job, 'outcome': 'acted', 'reason': 'delivery observed'}))
                    return 0
            if channel.get('phase') == 'draining' and channel.get('session', '').startswith('codex:') and getattr(args, 'wake_evidence_root', None):
                backlog = channel.get('handover', {}).get('backlog', [])
                awaiting = next((item for item in channel['queue'] if item.get('id') in backlog and item.get('state') == 'accepted'), None)
                if awaiting:
                    identity = {'channel': args.channel, 'session': channel['session'], 'generation': channel['generation'], 'id': awaiting['id'], 'queueId': awaiting.get('nativeQueueId')}
                    if channel.get('wakeReservation') or state.get('wakeAttempt', {}).get('identity') == identity:
                        print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'wake attempt unresolved; inspect before retry'}))
                        return 3
                    if not isinstance(identity['queueId'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', identity['queueId']):
                        raise ValueError('native queue identity unavailable')
                    if not preflight_codex_channel_wake(awaiting, channel):
                        print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'wake not ready'}))
                        return 3
                    state['wakeAttempt'] = {'identity': identity, 'status': 'attempted'}
                    save_state(path, state)
                    evidence = start_codex_channel_wake(args, awaiting, channel)
                    current = channel_call(args, 'get')
                    matched = [item for item in current['queue'] if item.get('id') == identity['id'] and item.get('session') == identity['session'] and item.get('generation') == identity['generation'] and item.get('state') == 'observed' and item.get('wakeEvidence') == evidence]
                    if current.get('session') != identity['session'] or current.get('generation') != identity['generation'] or len(matched) != 1:
                        raise ValueError('wake settlement not observed')
                    state['wakeAttempt']['status'] = 'verified'
                    save_state(path, state)
                    print(json.dumps({'job': args.job, 'outcome': 'acted', 'reason': 'wake verified'}))
                    return 0
            pending = next((item for item in channel['queue'] if item.get('state') == 'pending'), None)
            if not pending:
                print(json.dumps({'job': args.job, 'outcome': 'noop'}))
                return 0
            target = channel['session']
            generation = channel['generation']
            if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
                raise ValueError('invalid channel generation')
            cloud_profile = cloud_scope = None
            if target.startswith('claude-cloud:'):
                session, cloud_profile, cloud_scope = cloud_target(target, getattr(args, 'cloud_profile_root', None))
                agent = 'claude'
            else:
                agent, sep, session = target.partition(':')
                if not sep or agent not in ('codex', 'claude'):
                    raise ValueError('unsupported channel recipient')
            channel = channel_call(args, 'begin-delivery', '--id', pending['id'], '--session', target, '--generation', str(generation))
            item = next(item for item in channel['queue'] if item['id'] == pending['id'])
            if item['session'] != target or item['generation'] != generation:
                raise ValueError('unsupported channel recipient')
            transport_receipt = {}
            options = {'cloud_profile': cloud_profile, 'cloud_scope': cloud_scope} if cloud_profile else {}
            code = deliver(agent, session, item['id'], item['payload'], None if cloud_profile else args.managed_inbox_root,
                           True, resume=args.resume and agent == 'codex', message_stdin=True, receipt_out=transport_receipt, **options)
            if code != 0:
                print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'delivery unconfirmed'}))
                return 3
            if cloud_profile:
                print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'cloud queued; receipt unverified'}))
                return 3
            receipt = {'status': 'accepted', 'messageId': item['id'], 'session': item['session'], 'generation': item['generation']}
            receipt.update(transport_receipt)
            channel_call(args, 'acknowledge', '--id', item['id'], '--input', json.dumps(receipt, separators=(',', ':')))
            print(json.dumps({'job': args.job, 'outcome': 'acted', 'correlationId': item['id']}))
            return 0
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, StopIteration):
            print(json.dumps({'job': args.job, 'outcome': 'blocked', 'reason': 'channel unavailable or delivery unresolved'}))
            return 3


def run(args: argparse.Namespace) -> int:
    if getattr(args, 'channel', None):
        return run_channel(args)
    path = Path(args.state) if args.state else state_dir() / f"{args.job}.json"
    with locked(path) as acquired:
        if not acquired:
            print(json.dumps({"job": args.job, "outcome": "noop", "reason": "previous run still active"}))
            return 0
        state, state_errors = load_state(path)
        new, errors = run_producer(args.producer, args.producer_timeout)
        errors = state_errors + errors
        known = {entry["key"] for entry in state["pending"]}
        for item in new:
            key = item_key(item)
            if key not in known:
                known.add(key)
                state["pending"].append({"key": key, "item": item})
        signature = error_signature(errors)
        wake_errors = errors if signature and signature != state.get("errorSignature") else []
        if not errors:
            state["errorSignature"] = None
        # Persist before delivering so a crash after the producer advanced its cursor keeps the items.
        save_state(path, state)
        summary = {"job": args.job, "new": len(new), "pending": len(state["pending"]), "errors": len(errors)}
        recipient = {"agent": args.agent, "session": args.session, "inboxRoot": args.managed_inbox_root,
                     "deliveryOnly": args.delivery_only, "resume": args.resume}
        flight = state.get("inFlight")
        if flight and flight.get("recipient") != recipient:
            print(json.dumps({**summary, "outcome": "blocked", "reason": "in-flight recipient/configuration changed"}))
            return 3
        if not state["pending"] and not wake_errors and not flight:
            record(args.job, "noop", args.session, "nothing new")
            print(json.dumps({**summary, "outcome": "noop"}))
            return 0
        if not flight:
            flight = {"correlationId": f"waker-{args.job}-{uuid.uuid4()}", "recipient": recipient,
                      "message": compose(args.job, state["pending"], wake_errors),
                      "itemKeys": [entry["key"] for entry in state["pending"][:MAX_LISTED]], "errorSignature": signature}
            state["inFlight"] = flight
            save_state(path, state)
        correlation = flight["correlationId"]
        code = deliver(args.agent, args.session, correlation, flight["message"],
                       args.managed_inbox_root, args.delivery_only, **({"resume": True} if args.resume else {}))
        if code == DEAD_FLIGHT:
            state.pop("inFlight", None)
            save_state(path, state)
        if code not in QUEUED:
            record(args.job, "blocked", args.session, f"delivery refused rc={code}")
            print(json.dumps({**summary, "outcome": "blocked", "deliveryExit": code}))
            return 3
        state["lastDelivery"] = {"correlationId": correlation, "at": time.time(),
                                 "itemKeys": flight["itemKeys"]}
        accepted = set(flight["itemKeys"])
        state["pending"] = [entry for entry in state["pending"] if entry["key"] not in accepted]
        state.pop("inFlight", None)
        if flight["errorSignature"]:
            state["errorSignature"] = flight["errorSignature"]
        save_state(path, state)
        record(args.job, "acted", args.session, f"transport accepted {len(accepted)} item(s); actor response unverified")
        print(json.dumps({**summary, "outcome": "acted", "correlationId": correlation, "deliveryExit": code}))
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run", help="run the producer once and deliver anything new")
    runner.add_argument("--job", required=True)
    runner.add_argument("--agent", default="claude", choices=("claude", "codex"))
    recipient = runner.add_mutually_exclusive_group(required=True)
    recipient.add_argument("--session", help="owning session UUID")
    recipient.add_argument("--channel", help="stable channel identifier")
    runner.add_argument("--graph-state", help="override graph state for isolated tests")
    runner.add_argument("--wake-evidence-root", help="opt in to explicit Codex backlog wake with a private evidence root")
    runner.add_argument("--cloud-profile-root", help="private directory for scoped cloud account profiles")
    runner.add_argument("--managed-inbox-root", help="required for Claude sessions")
    runner.add_argument("--delivery-only", action="store_true", help="acknowledge the native queue, without waiting for a result")
    runner.add_argument("--resume", action="store_true", help="opt in to native Codex resume when idle")
    runner.add_argument("--state", help="defaults to $XDG_STATE_HOME/agent-waker/<job>.json")
    runner.add_argument("--producer-timeout", type=int, default=280)
    runner.add_argument("producer", nargs=argparse.REMAINDER, help="-- command that prints the JSON report")
    args = parser.parse_args(argv)
    if args.wake_evidence_root and (not args.channel or not args.graph_state or not os.path.isabs(args.graph_state) or not os.path.isabs(args.wake_evidence_root) or args.resume):
        parser.error('--wake-evidence-root requires --channel, absolute --graph-state, and no --resume')
    if args.channel and not args.delivery_only:
        parser.error("--channel requires --delivery-only")
    if args.resume and not args.channel and args.agent != "codex":
        parser.error("--resume requires --agent codex")
    if args.producer[:1] == ["--"]:
        args.producer = args.producer[1:]
    if not args.producer:
        parser.error("missing producer command after --")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
