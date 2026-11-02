#!/usr/bin/env python3
"""Call external work-ledger adapters; keep only per-consumer opaque cursors."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

SCHEMA = 'agent-mesh.ledger-adapter.v1'
MAX_BYTES = 1024 * 1024
MAX_CURSOR_BYTES = 32 * MAX_BYTES
STATUSES = {'open', 'active', 'waiting', 'blocked', 'done', 'cancelled', 'deleted'}
SCHEME = re.compile(r'^[a-z][a-z0-9+.-]{0,63}$')
NAME = re.compile(r'^[A-Za-z0-9._-]{1,128}$')
FIELDS = {'ref', 'title', 'state', 'status', 'assignee', 'domain', 'nextAction', 'waitingOn', 'resumeCondition', 'sessions', 'updatedAt', 'url'}

class ProtocolError(Exception):
    pass

def read_json(path, default, limit=MAX_BYTES):
    if not path.exists():
        return default
    if path.stat().st_size > limit:
        raise ProtocolError('JSON file exceeds size limit')
    try:
        return json.loads(path.read_text())
    except (ValueError, UnicodeError):
        raise ProtocolError('invalid JSON file') from None

def adapters():
    path = Path(os.environ.get('MESH_LEDGERS_FILE', Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'agent-mesh/ledgers.json'))
    config = read_json(path, {})
    if config == {}:
        return {}
    if not isinstance(config, dict) or config.get('schemaVersion') != 1 or not isinstance(config.get('adapters'), list):
        raise ProtocolError('invalid adapter configuration')
    result = {}
    for entry in config['adapters']:
        if not isinstance(entry, dict):
            raise ProtocolError('invalid adapter configuration')
        scheme = entry.get('scheme', '')
        argv = entry.get('command')
        timeout = entry.get('timeoutMs', 10000)
        if not isinstance(scheme, str) or not SCHEME.fullmatch(scheme) or scheme in result:
            raise ProtocolError('invalid or duplicate adapter scheme')
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or not arg or '\0' in arg for arg in argv):
            raise ProtocolError('adapter command must be a nonempty argv array')
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 120000:
            raise ProtocolError('invalid adapter timeout')
        if 'linkSessions' in entry and not isinstance(entry['linkSessions'], bool):
            raise ProtocolError('linkSessions must be boolean')
        result[scheme] = {**entry, 'timeoutMs': timeout}
    return result

def run_process(argv, payload=None, *, timeout_ms=10000, max_output=MAX_BYTES, label='adapter'):
    """Bound helper pipes while reading and retire only this invocation group.

    Persistent workers must use their native detached service/tmux transport.
    """
    deadline = time.monotonic() + timeout_ms / 1000
    encoded = json.dumps(payload).encode() if payload is not None else b''
    if len(encoded) > MAX_BYTES:
        raise ProtocolError(label + ' request exceeds size limit')
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        raise ProtocolError(label + ' could not start') from None
    try:
        sent, data = 0, bytearray()
        os.set_blocking(process.stdin.fileno(), False)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if encoded:
                selector.register(process.stdin, selectors.EVENT_WRITE)
            else:
                process.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProtocolError(label + ' timed out')
                for key, _ in selector.select(remaining):
                    if key.fileobj is process.stdin:
                        sent += os.write(key.fd, encoded[sent:sent + 65536])
                        if sent == len(encoded):
                            selector.unregister(process.stdin)
                            process.stdin.close()
                        continue
                    chunk = os.read(key.fd, min(65536, max_output + 1 - len(data)))
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        data.extend(chunk)
                        if len(data) > max_output:
                            raise ProtocolError(label + ' output exceeds size limit')
        try:
            code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ProtocolError(label + ' timed out') from None
        return code, bytes(data)
    except (BrokenPipeError, OSError):
        raise ProtocolError(label + ' transport failed') from None
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def invoke(adapter, operation, request, expected_schema=SCHEMA):
    """Invoke the adapter protocol over the shared bounded helper transport."""
    code, data = run_process([*adapter['command'], operation], request, timeout_ms=adapter['timeoutMs'])
    if code:
        raise ProtocolError('adapter failed')
    try:
        response = json.loads(data)
    except (ValueError, UnicodeError):
        raise ProtocolError('adapter returned invalid JSON') from None
    if not isinstance(response, dict) or expected_schema and response.get('schema') != expected_schema:
        raise ProtocolError('adapter returned invalid schema')
    return response


def one_line(value, name, limit=4096):
    if not isinstance(value, str) or len(value) > limit or '\n' in value or '\r' in value:
        raise ProtocolError('invalid item ' + name)
    return value

def iso(value):
    if not isinstance(value, str):
        raise ProtocolError('invalid item timestamp')
    try:
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if not stamp.tzinfo:
            raise ValueError()
    except ValueError:
        raise ProtocolError('invalid item timestamp') from None
    return value

def item(raw, scheme):
    if not isinstance(raw, dict):
        raise ProtocolError('invalid item')
    result = {key: value for key, value in raw.items() if key in FIELDS}
    ref = one_line(result.get('ref'), 'ref', 512)
    if not ref.startswith(scheme + ':') or not ref[len(scheme) + 1:] or any(ch.isspace() for ch in ref):
        raise ProtocolError('item ref does not belong to adapter')
    one_line(result.get('title'), 'title', 512)
    if not isinstance(result.get('status'), str) or result['status'] not in STATUSES:
        raise ProtocolError('invalid item status')
    iso(result.get('updatedAt'))
    for key in ('state', 'assignee', 'domain', 'nextAction', 'resumeCondition', 'url'):
        if key in result:
            one_line(result[key], key)
    if 'waitingOn' in result:
        wait = result['waitingOn']
        if not isinstance(wait, dict) or not isinstance(wait.get('who'), str) or wait['who'] not in {'human', 'agent', 'external'}:
            raise ProtocolError('invalid waiting owner')
        result['waitingOn'] = {key: value for key, value in wait.items() if key in {'who', 'ask', 'urgency', 'due'}}
        if 'ask' in wait:
            one_line(wait['ask'], 'waitingOn.ask')
        if 'urgency' in wait and (not isinstance(wait['urgency'], str) or wait['urgency'] not in {'low', 'normal', 'high'}):
            raise ProtocolError('invalid waiting urgency')
        if 'due' in wait:
            iso(wait['due'])
    if 'sessions' in result:
        if not isinstance(result['sessions'], list) or len(result['sessions']) > 200:
            raise ProtocolError('invalid item sessions')
        sessions = []
        for session in result['sessions']:
            if not isinstance(session, dict) or not isinstance(session.get('session'), str) or not re.fullmatch(r'(?:(?:codex|claude):)?[0-9a-fA-F-]{8,36}', session['session']):
                raise ProtocolError('invalid item session')
            clean = {key: value for key, value in session.items() if key in {'session', 'role', 'at'}}
            if 'role' in clean and (not isinstance(clean['role'], str) or clean['role'] not in {'owns', 'works-on', 'reviews', 'coordinates', 'discusses', 'observes', 'mentioned'}):
                raise ProtocolError('invalid item session role')
            if 'at' in clean:
                iso(clean['at'])
            sessions.append(clean)
        result['sessions'] = sessions
    return result

def checked(response, scheme, operation, requested=()):
    if not isinstance(response.get('items'), list) or len(response['items']) > 200 or not isinstance(response.get('errors', []), list):
        raise ProtocolError('invalid adapter page')
    result = {'schema': SCHEMA, 'items': [item(raw, scheme) for raw in response['items']],
              # Adapter errors can contain diagnostics; expose only affected refs and a fixed label.
              'errors': [{'ref': err.get('ref') if isinstance(err, dict) and err.get('ref') in requested else None,
                          'error': 'adapter item error'} for err in response.get('errors', [])]}
    refs = [entry['ref'] for entry in result['items']]
    if len(refs) != len(set(refs)):
        raise ProtocolError('adapter page contains duplicate refs')
    if operation == 'describe':
        missing = response.get('missing')
        if not isinstance(missing, list) or any(ref not in requested for ref in missing) or any(ref not in requested for ref in refs):
            raise ProtocolError('invalid describe refs')
        if len(missing) != len(set(missing)) or set(missing).intersection(refs):
            raise ProtocolError('invalid missing refs')
        if not result['errors'] and set(refs + missing) != set(requested):
            raise ProtocolError('describe omitted requested refs')
        result['missing'] = missing
    else:
        if not isinstance(response.get('cursor'), str) or len(response['cursor']) > MAX_BYTES // 2 or not isinstance(response.get('more'), bool):
            raise ProtocolError('invalid adapter cursor')
        result.update(cursor=response['cursor'], more=response['more'])
    return result

@contextmanager
def cursor_store():
    root = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'agent-mesh/ledger'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / 'cursors.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ProtocolError('cursor store busy')
                time.sleep(0.02)
        path = root / 'cursors.json'
        state = read_json(path, {'schemaVersion': 1, 'cursors': {}}, limit=MAX_CURSOR_BYTES)
        if not isinstance(state, dict) or state.get('schemaVersion') != 1 or not isinstance(state.get('cursors'), dict) or any(not isinstance(value, str) for value in state['cursors'].values()):
            raise ProtocolError('invalid cursor store')
        try:
            yield path, state
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)

def save(path, state):
    payload = json.dumps(state, sort_keys=True)
    if len(payload.encode()) > MAX_CURSOR_BYTES:
        raise ProtocolError('cursor store exceeds size limit')
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)

def capabilities(adapter, scheme):
    response = invoke(adapter, 'capabilities', {})
    if not isinstance(response.get('schemes'), list) or not isinstance(response.get('operations'), list) or any(not isinstance(op, str) for op in response['operations']) or scheme not in response['schemes'] or not {'describe', 'changes'} <= set(response['operations']) or not isinstance(response.get('sessionField'), bool):
        raise ProtocolError('invalid adapter capabilities')
    return {'scheme': scheme, 'operations': response['operations'], 'sessionField': response['sessionField']}

def changes(adapter, args, before_advance=None):
    with cursor_store() as (path, state):
        key = args.scheme + ':' + args.consumer
        request = {'cursor': None if args.full else state['cursors'].get(key), 'limit': 200}
        if args.full:
            request['full'] = True
        response = checked(invoke(adapter, 'changes', request), args.scheme, 'changes')
        if before_advance and not response['errors']:
            response['sync'] = before_advance(response['items'])
            if response['sync'].get('unresolved'):
                response['errors'].append({'error': 'session references unresolved'})
        if not args.peek and not response['errors']:
            state['cursors'][key] = response['cursor']
            save(path, state)
        return response

def sync_links(items):
    if not items:
        return {'changed': False, 'events': 0, 'unresolved': []}
    helper = Path(__file__).with_name('mesh-graph.mjs')
    return invoke({'command': ['node', str(helper), '--json', '--input', '-', 'ledger'], 'timeoutMs': 10000},
                  'sync', {'items': items}, expected_schema=None)

def matches(value, expression):
    clauses = expression.split(',') if expression else []
    if any('=' not in clause or not clause.split('=', 1)[0] for clause in clauses):
        raise ProtocolError('filter must contain field=value clauses')
    for clause in clauses:
        field, expected = clause.split('=', 1)
        current = value
        for key in field.split('.'):
            current = current.get(key) if isinstance(current, dict) else None
        if current != expected:
            return False
    return True

def conformance(adapter, scheme):
    capabilities(adapter, scheme)
    unknown = scheme + ':__conformance_missing_' + os.urandom(12).hex()
    described = checked(invoke(adapter, 'describe', {'refs': [unknown]}), scheme, 'describe', [unknown])
    if described['missing'] != [unknown] or described['errors'] or described['items']:
        raise ProtocolError('unknown ref must be missing')
    first = checked(invoke(adapter, 'changes', {'cursor': None, 'limit': 200}), scheme, 'changes')
    if first['items'] or first['errors'] or first['more']:
        raise ProtocolError('null cursor must establish a quiet baseline')
    for _ in range(2):
        page = checked(invoke(adapter, 'changes', {'cursor': first['cursor'], 'limit': 200}), scheme, 'changes')
        if page['items'] or page['errors'] or page['more']:
            raise ProtocolError('unchanged cursor must stay quiet')
    return {'schema': SCHEMA, 'scheme': scheme, 'outcome': 'pass'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('adapters').add_argument('--json', action='store_true')
    describe = commands.add_parser('describe')
    describe.add_argument('refs', nargs='+')
    describe.add_argument('--json', action='store_true')
    for command in ('changes', 'producer', 'sync'):
        sub = commands.add_parser(command)
        sub.add_argument('--scheme', required=True)
        sub.add_argument('--consumer', default='plexus' if command == 'sync' else 'default' if command == 'changes' else None, required=command == 'producer')
        sub.add_argument('--peek', action='store_true')
        sub.add_argument('--full', action='store_true')
        sub.add_argument('--filter', default='')
        sub.add_argument('--json', action='store_true')
    check = commands.add_parser('conformance')
    check.add_argument('--scheme', required=True)
    args = parser.parse_args()
    try:
        configured = adapters()
        if args.command == 'adapters':
            result = {'adapters': [capabilities(adapter, scheme) for scheme, adapter in configured.items()], 'status': 'ok' if configured else 'no-adapter'}
        elif args.command == 'describe':
            if len(args.refs) > 200:
                raise ProtocolError('at most 200 refs may be described')
            result = {'schema': SCHEMA, 'items': [], 'missing': [], 'errors': []}
            groups = {}
            for ref in dict.fromkeys(args.refs):
                scheme = ref.split(':', 1)[0]
                if scheme not in configured:
                    result['missing'].append(ref)
                else:
                    groups.setdefault(scheme, []).append(ref)
            for scheme, refs in groups.items():
                page = checked(invoke(configured[scheme], 'describe', {'refs': refs}), scheme, 'describe', refs)
                for key in ('items', 'missing', 'errors'):
                    result[key].extend(page[key])
        else:
            if not SCHEME.fullmatch(args.scheme):
                raise ProtocolError('invalid scheme')
            if args.command in {'changes', 'producer', 'sync'} and not NAME.fullmatch(args.consumer):
                raise ProtocolError('invalid consumer')
            adapter = configured.get(args.scheme)
            if not adapter:
                result = {'status': 'no-adapter', 'items': [], 'errors': [], 'more': False}
            elif args.command == 'sync' and adapter.get('linkSessions') is False:
                result = {'status': 'link-sync-disabled', 'items': [], 'errors': []}
            elif args.command == 'conformance':
                result = conformance(adapter, args.scheme)
            else:
                # Validate the filter before advancing the cursor.
                matches({}, args.filter)
                if args.command == 'sync' and (args.consumer != 'plexus' or args.peek):
                    raise ProtocolError('sync owns the plexus consumer and does not support peek')
                result = changes(adapter, args, before_advance=sync_links if args.command == 'sync' else None)
            if args.command == 'producer':
                result = {'new': [{'id': value['ref'] + ':' + value['updatedAt'], **value} for value in result.get('items', []) if matches(value, args.filter)], 'errors': result['errors'], 'more': result.get('more', False), **({'status': 'no-adapter'} if not adapter else {})}
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (ProtocolError, OSError) as error:
        # Fixed diagnostics only; never forward adapter stderr or raw JSON.
        result = {'new': [], 'errors': [{'source': 'ledger', 'error': str(error) if isinstance(error, ProtocolError) else 'ledger I/O failed'}]}
        print(json.dumps(result, sort_keys=True))
        return 1

if __name__ == '__main__':
    sys.exit(main())
