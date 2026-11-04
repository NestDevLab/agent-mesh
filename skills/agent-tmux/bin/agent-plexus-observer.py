#!/usr/bin/env python3
"""Scoped Plexus producer; existing waker owns transport and communication policy."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import uuid

BIN = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), BIN / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


follow, waker = load('agent-follow'), load('agent-waker')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    follow.atomic_json(path, value)
    os.chmod(path, 0o600)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def query(config, name, values):
    command = ['node', str(BIN / 'mesh-graph.mjs')]
    if config.get('graphState'):
        command += ['--state', str(Path(config['graphState']).expanduser())]
    try:
        result = subprocess.run(command + ['query', name, '--input', json.dumps(values)],
                                capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('Plexus query timed out') from error
    if result.returncode:
        raise RuntimeError('Plexus query failed')
    return json.loads(result.stdout)


def bound(config, key, default, maximum):
    value = config.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError('invalid observer work bound')
    return value


def validate(config):
    if not isinstance(config.get('destination'), str) or ':' not in config['destination']:
        raise ValueError('observer requires destination identity')
    subscriptions = config.get('subscriptions')
    if not isinstance(subscriptions, list) or not 1 <= len(subscriptions) <= 16:
        raise ValueError('observer requires bounded subscriptions')
    ids = set()
    for sub in subscriptions:
        if not isinstance(sub.get('id'), str) or not sub['id'] or sub['id'] in ids:
            raise ValueError('observer subscription identity must be unique')
        ids.add(sub['id'])
        for key in ('sessions', 'refs', 'projects', 'eventTypes'):
            if key in sub and (not isinstance(sub[key], list) or not sub[key] or
                               not all(isinstance(x, str) and x for x in sub[key])):
                raise ValueError('invalid observer selector')
        if not any(sub.get(key) for key in ('sessions', 'refs', 'projects')) and sub.get('all') is not True:
            raise ValueError('unscoped subscription requires all: true')
    bound(config, 'maxPages', 2, 20)
    bound(config, 'pageSize', 100, 200)
    bound(config, 'maxCatalogPages', 25, 50)


def catalog(config, ask):
    result, cursor = {}, None
    for _ in range(bound(config, 'maxCatalogPages', 25, 50)):
        page = ask(config, 'search', {'limit': 200, **({'cursor': cursor} if cursor else {})})
        for session in page['sessions']:
            result[session['sessionId']] = session.get('project')
        next_cursor = page.get('cursor')
        if not next_cursor:
            return result
        if next_cursor == cursor:
            raise RuntimeError('Plexus catalog cursor did not advance')
        cursor = next_cursor
    raise RuntimeError('Plexus catalog work bound exceeded')


def admitted(event, sub, projects, destination):
    subjects = [event[key] for key in ('session', 'from', 'to') if event.get(key) and event.get(key) != event.get('ref')]
    if destination in subjects:
        return False
    if sub.get('eventTypes') and event.get('type') not in sub['eventTypes']:
        return False
    if sub.get('sessions') and (not subjects or any(x not in sub['sessions'] for x in subjects)):
        return False
    if sub.get('projects') and (not subjects or any(projects.get(x) not in sub['projects'] for x in subjects)):
        return False
    return True


def producer(config, root, ask=query):
    validate(config)
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    with follow.locked(root / 'producer.lock', nonblocking=True):
        path = root / 'state.json'
        identity = digest({key: value for key, value in config.items() if key != 'wakerState'})
        state = follow.read_json(path, {'version': 1, 'identity': identity, 'cursors': {}, 'seen': [], 'pending': None})
        if state.get('version') != 1 or state.get('identity') != identity:
            raise ValueError('observer configuration changed; use a new state namespace')
        pending = state['pending']
        if pending:
            receipt = follow.read_json(Path(config['wakerState']).expanduser(), {}) if config.get('wakerState') else {}
            keys = (receipt.get('lastDelivery') or {}).get('itemKeys', [])
            if pending['key'] not in keys:
                return {'new': [pending['item']], 'errors': []}
            # Only transport acceptance commits the cursor. Actor response is separate evidence.
            state['cursors'] = pending['cursors']
            state['seen'] = (state['seen'] + pending['seen'])[-10000:]
            state['lastTransportReceipt'] = receipt['lastDelivery']
            state['pending'] = None
            save(path, state)
        cursors = dict(state['cursors'])
        rows, seen = [], set(state['seen'])
        projects = catalog(config, ask) if any(s.get('projects') for s in config['subscriptions']) else {}
        for sub in config['subscriptions']:
            if sub.get('projects'):
                missing = sum(project is None for project in projects.values())
                gap_id = 'coverage:' + digest([sub['projects'], missing, len(projects)])
                gap_key = sub['id'] + ':' + gap_id
                if missing and gap_key not in seen:
                    seen.add(gap_key)
                    rows.append({'subscription': sub['id'], 'type': 'observer.coverage_gap',
                                 'eventId': gap_id, 'unclassifiedSessions': missing,
                                 'detail': 'Project membership unknown; those sessions are excluded.'})
            cursor = cursors.get(sub['id'])
            if cursor is None:
                page = ask(config, 'changes', {'initial': 'head'})
                cursors[sub['id']] = page['cursor']
                continue
            for _ in range(bound(config, 'maxPages', 2, 20)):
                values = {'sinceCursor': cursor, 'limit': bound(config, 'pageSize', 100, 200)}
                if sub.get('refs'):
                    values['refs'] = sub['refs']
                page = ask(config, 'changes', values)
                next_cursor = page['cursor']
                if not isinstance(next_cursor, str) or not next_cursor:
                    raise ValueError('invalid Plexus cursor')
                cursors[sub['id']] = next_cursor
                if page.get('reset'):
                    rows.append({'subscription': sub['id'], 'type': 'observer.reset',
                                 'eventId': 'reset:' + digest([cursor, next_cursor]),
                                 'detail': 'Feed retention changed; baseline recovered. Missing history is unverified.'})
                    break
                for event in page['events']:
                    key = sub['id'] + ':' + event['eventId']
                    if key in seen or not admitted(event, sub, projects, config['destination']):
                        continue
                    seen.add(key)
                    rows.append({'subscription': sub['id'], **event})
                if next_cursor == cursor:
                    if page['events']:
                        raise RuntimeError('Plexus changes cursor did not advance')
                    break
                cursor = next_cursor
                if not page['events']:
                    break
        if not rows:
            state['cursors'] = cursors
            save(path, state)
            return {'new': [], 'errors': []}
        report_path = root / 'reports' / (str(uuid.uuid4()) + '.json')
        report = {'kind': 'system-event', 'authority': 'observation-only; never human approval',
                  'destination': config['destination'], 'actorResponse': 'unverified', 'events': rows}
        save(report_path, report)
        item = {'kind': 'system-event', 'detail': str(report_path) + ' | Plexus: ' + str(len(rows)) +
                ' scoped event(s). Observation only; never human approval. Read report; acknowledge separately.'}
        state['pending'] = {'item': item, 'key': waker.item_key(item), 'cursors': cursors,
                            'seen': [row['subscription'] + ':' + row['eventId'] for row in rows]}
        save(path, state)
        return {'new': [item], 'errors': []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = producer(json.loads(args.config.read_text()), args.state)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.TimeoutExpired):
        print(json.dumps({'new': [], 'errors': [{'source': 'plexus-observer', 'error': 'observer source or state failure'}]}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
