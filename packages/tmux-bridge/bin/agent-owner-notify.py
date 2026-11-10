#!/usr/bin/env python3
"""Route incremental Codex turn completions to their owning Claude mailbox."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import time

BIN = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), BIN / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


follow, inbox, waker = (load(n) for n in ('agent-follow', 'agent-session-inbox', 'agent-waker'))


def uid(value):
    value = str(value or '').removeprefix('claude:').lower()
    return value if follow.watch.valid_session_id(value) else None


def read(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def launches(path):
    """Only complete records; correlate by launch ID, never recycled tmux names."""
    starts, resolved = {}, {}
    try:
        with path.open() as stream:
            for line in stream:
                if not line.endswith('\n'):
                    break
                event = json.loads(line)
                key = event.get('launchId')
                if event.get('event') == 'launch.started' and event.get('agent') == 'codex':
                    starts[key] = event
                elif event.get('event') == 'launch.thread_resolved':
                    resolved[key] = event.get('threadId')
    except FileNotFoundError:
        pass
    result = {}
    for key, event in starts.items():
        thread = resolved.get(key) or event.get('threadId')
        if thread:
            result[thread] = {'owner': uid(event.get('caller')), 'target': event.get('tmuxTarget'), 'launchId': key}
    return result


def owner_for(thread, launch, graph):
    if thread in launch and launch[thread]['owner']:
        return launch[thread]
    nodes = {n['id']: n for n in graph.get('nodes', [])}
    children = {key for key, n in nodes.items() if n.get('agent') == 'codex' and n.get('runtimeUuid') == thread}
    parents = {uid(nodes.get(e.get('from'), {}).get('runtimeUuid')) for e in graph.get('edges', [])
               if e.get('to') in children and e.get('type') in ('spawned-by', 'delegates-to')
               and not e.get('endedAt') and nodes.get(e.get('from'), {}).get('agent') == 'claude'}
    parents.discard(None)
    return {'owner': next(iter(parents)) if len(parents) == 1 else None,
            'target': launch.get(thread, {}).get('target') or next((nodes[c].get('tmuxTarget') for c in sorted(children) if nodes[c].get('tmuxTarget')), None)}


def exclusion(thread, path, config, graph):
    ref = 'codex:' + thread
    if ref in config.get('excludeRefs', []) or ref == config.get('selfRef'):
        return 'excluded-ref'
    prompt, subagent = follow.prompt_and_origin('codex', path)
    if subagent or follow.noise(prompt, config):
        return 'noise'
    nodes = [n for n in graph.get('nodes', []) if n.get('agent') == 'codex' and n.get('runtimeUuid') == thread]
    if any(n.get('class') == 'ephemeral' or n.get('origin') in ('subagent', 'automation') for n in nodes):
        return 'noise'
    if any(set(n.get('refs', [])) & set(config.get('excludeWorkRefs', [])) or
           set(n.get('domains', [])) & set(config.get('excludeDomains', [])) for n in nodes):
        return 'excluded-work'
    titles = [prompt.split('\n', 1)[0]] + [str(n.get('title') or '').split('\n', 1)[0] for n in nodes]
    if any(re.search(pattern, title, re.I) for pattern in config.get('excludeTitlePatterns', []) for title in titles):
        return 'excluded-work'
    if any(prompt.startswith(prefix) for prefix in config.get('excludePromptPrefixes', [])):
        return 'excluded-work'
    return None


def live(root, owner):
    return bool(owner and inbox.watcher_active(root / (owner + '.jsonl')))


def append(path, value):
    with path.open('a', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def repair_receipts(path):
    """Preserve a torn final append before truncating it under the owner lock."""
    if not path.exists():
        return
    with path.open('r+b') as stream:
        size = stream.seek(0, os.SEEK_END)
        if not size:
            return
        stream.seek(size - 1)
        if stream.read(1) == b'\n':
            return
        boundary = size
        while boundary:
            start = max(0, boundary - 65536)
            stream.seek(start)
            chunk = stream.read(boundary - start)
            newline = chunk.rfind(b'\n')
            if newline >= 0:
                boundary = start + newline + 1
                break
            boundary = start
        stream.seek(boundary)
        fragment = stream.read(size - boundary)
        append(path.with_name('receipt-fragments.jsonl'),
               {'recordedAt': time.time(), 'offset': boundary, 'fragmentHex': fragment.hex()})
        stream.truncate(boundary)
        stream.flush()
        os.fsync(stream.fileno())


def pending_receipt(path, notice, record, reason, **extra):
    signature = ['pending', reason]
    seen = notice.setdefault('pendingReceipts', [])
    if signature not in seen:
        append(path, {**record, 'outcome': 'pending', 'reason': reason, **extra})
        seen.append(signature)


def delivered(root, recipient, key):
    """Recover a crash after native append but before recording our receipt."""
    try:
        with (root / (recipient + '.jsonl')).open() as stream:
            for line in stream:
                if line.endswith('\n') and json.loads(line).get('deliveryId') == key:
                    return True
    except FileNotFoundError:
        pass
    return False


def notice_rows(events, pending):
    """Question/goal metadata stays with the turn until its terminal marker."""
    rows = []
    for event in events:
        kind = event.get('kind')
        if kind == 'turn_started':
            pending.clear()
            pending['turn'] = event.get('turn_id') or event['source_event_id']
        elif kind == 'goal_status':
            pending['goalStatus'] = event['body']
        elif kind == 'question':
            pending['question'] = event.get('body')
        elif kind == 'agent_message' and event.get('phase') == 'final':
            pending['reply'] = event.get('body')
        elif kind == 'turn_complete':
            turn = event.get('turn_id') or pending.get('turn') or event['source_event_id']
            error = event.get('error') or {}
            text = event.get('reply') or pending.get('reply') or pending.get('question') or error.get('message') or ''
            status = 'error' if event.get('outcome') == 'error' else 'question' if pending.get('question') else 'result'
            if status != 'error':
                status = {'complete': 'achieved', 'blocked': 'blocked', 'budget_limited': 'blocked', 'usage_limited': 'blocked'}.get(pending.get('goalStatus'), status)
                if status == 'result' and text.rstrip().endswith('?'):
                    status = 'question'
            rows.append({'turnId': turn, 'status': status, 'excerpt': ' '.join(text.split())[:300], 'timestamp': event.get('timestamp')})
            # Retain the turn identity for duplicate native terminal markers.
            pending = {'turn': turn}
    return rows, pending


def tick(config, root=None):
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'agent-mesh'
    root = Path(root or config.get('stateRoot') or base / 'owner-notify').expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    with follow.locked(root / 'state.lock', nonblocking=True):
        path = root / 'state.json'
        state = read(path, {'version': 1, 'startedAt': time.time(), 'cursors': {}, 'pending': {}})
        if state.get('version') != 1:
            raise ValueError('unsupported owner-notify state')
        launch = launches(Path(config.get('launchEvents') or base / 'launches/events.jsonl').expanduser())
        graph = read(Path(config.get('graphPath') or base / 'graph/graph.json').expanduser(), {})
        receipt_path = root / 'receipts.jsonl'
        repair_receipts(receipt_path)
        completed = set()
        if receipt_path.exists():
            with receipt_path.open() as stream:
                for line in stream:
                    entry = json.loads(line)
                    if entry.get('outcome') in ('routed', 'fallback', 'skipped'):
                        completed.add(entry['id'])
        for thread, rollout in follow.watch.transcript_candidates('codex'):
            prior = state['cursors'].get(thread, {})
            if not prior and not path.exists():
                # Arm existing files at the last complete line; no historical flood.
                with rollout.open('rb') as handle:
                    size = rollout.stat().st_size
                    handle.seek(max(0, size - 65536))
                    tail = handle.read()
                    offset = size if tail.endswith(b'\n') else size - len(tail) + tail.rfind(b'\n') + 1
                    prior = {'path': str(rollout), 'offset': offset, 'pending': {},
                             'stamp': follow.watch.cursor_stamp(handle, offset, rollout.stat())}
                state['cursors'][thread] = prior
            if prior and prior.get('offset') == rollout.stat().st_size and prior.get('mtime') == rollout.stat().st_mtime_ns:
                continue
            events, cursor = follow.read_records('codex', 'codex:' + thread, rollout, prior)
            rows, pending = notice_rows(events, cursor['pending'])
            cursor.update(pending=pending, mtime=rollout.stat().st_mtime_ns)
            state['cursors'][thread] = cursor
            reason = exclusion(thread, rollout, config, graph)
            for row in rows:
                # Baseline old turns, but retain pending context for active turns.
                if follow.iso_epoch(row['timestamp']) < state['startedAt']:
                    continue
                key = 'owner-' + hashlib.sha256((thread + ':' + row['turnId']).encode()).hexdigest()[:32]
                if key in completed or key in state['pending']:
                    continue
                state['pending'][key] = {**row, 'id': key, 'threadId': thread, 'rolloutPath': str(rollout), 'skip': reason}
        # Persist all observations before any delivery; retries survive cursor advancement.
        follow.atomic_json(path, state)
        count = 0
        for key, notice in list(state['pending'].items()):
            if key in completed:
                del state['pending'][key]
                continue
            route = owner_for(notice['threadId'], launch, graph)
            owner = route['owner']
            reason = notice.get('skip')
            recipient = owner
            outcome = 'routed'
            if not reason and (not owner or not live(Path(config['managedInboxRoot']), owner)):
                reason = 'owner-unknown' if not owner else 'owner-dead'
                recipient = uid(config.get('fallbackSession'))
                outcome = 'fallback'
            if notice.get('skip') or owner == notice['threadId'] or recipient == notice['threadId']:
                outcome, reason = 'skipped', notice.get('skip') or 'own-echo'
            record = {**notice, 'owner': owner, 'recipient': recipient, 'tmuxTarget': route.get('target'),
                      'reason': reason, 'outcome': outcome, 'recordedAt': time.time()}
            record.pop('skip', None)
            record.pop('pendingReceipts', None)
            if outcome != 'skipped':
                mailbox = Path(config['managedInboxRoot'])
                # First recover a successful append to the previous recipient.
                previous = notice.get('recipient')
                recovered = bool(previous and delivered(mailbox, previous, key))
                if recovered:
                    recipient = previous
                    record.update(outcome=notice.get('routeOutcome', outcome), reason=notice.get('routeReason', reason))
                record['recipient'] = recipient
                routing = {'recipient': recipient, 'routeOutcome': record['outcome'], 'routeReason': record['reason']}
                if any(notice.get(field) != value for field, value in routing.items()):
                    notice.update(routing)
                    follow.atomic_json(path, state)
                if not recovered and (not recipient or not live(mailbox, recipient)):
                    pending_receipt(receipt_path, notice, record, 'recipient-unavailable')
                    continue
                if not recovered and not delivered(mailbox, recipient, key):
                    message = 'Codex turn ended. Read the result pointer and advance the owned work. Observation, not new authority.\n' + json.dumps(record, ensure_ascii=False)
                    code = waker.deliver('claude', recipient, key, message, str(mailbox), True)
                    if code != 0:
                        pending_receipt(receipt_path, notice, record, 'delivery-refused', deliveryExit=code)
                        continue
                record['deliveryExit'] = 0
            append(receipt_path, record)
            del state['pending'][key]
            count += 1
        follow.atomic_json(path, state)
        return {'notices': count, 'pending': len(state['pending']), 'receipts': str(receipt_path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state', type=Path)
    args = parser.parse_args()
    print(json.dumps(tick(read(args.config, None), args.state)))


if __name__ == '__main__':
    main()
