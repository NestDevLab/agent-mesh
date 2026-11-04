#!/usr/bin/env python3
"""Durable inter-session delivery gate. Transport acknowledgements are not task completion."""
import argparse
import contextlib
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import stat
import re
import subprocess
import sys
import time
from datetime import datetime

BIN = Path(__file__).resolve().parent


def root():
    return Path(os.environ.get('MESH_COMMS_STATE', str(Path(os.environ.get('XDG_STATE_HOME', str(Path.home()/'.local/state')))/'agent-mesh/comms')))


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


@contextlib.contextmanager
def locked():
    home = root()
    home.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('comms state must be private and owned')
    fd = os.open(home/'delivery.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        path = home/'comms.sqlite'
        if path.is_symlink():
            raise ValueError('comms database cannot be a symlink')
        db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        db.execute('PRAGMA synchronous=FULL')
        db.executescript('''CREATE TABLE IF NOT EXISTS policy(scope TEXT PRIMARY KEY, mode TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS auto_release(scope TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS ledger(seq INTEGER PRIMARY KEY, at REAL, action TEXT, scope TEXT, reason TEXT, actor TEXT);
          CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, runtime TEXT, digest TEXT,
            payload TEXT, origin TEXT, created REAL, expires REAL, status TEXT, detail TEXT, destination TEXT, body_digest TEXT, cap_hash TEXT, dispatcher_pid INTEGER, dispatcher_start TEXT, cap_used INTEGER);''')
        columns = {r[1] for r in db.execute('PRAGMA table_info(deliveries)')}
        for name, kind in [('cap_hash','TEXT'),('dispatcher_pid','INTEGER'),('dispatcher_start','TEXT'),('cap_used','INTEGER')]:
            if name not in columns: db.execute(f'ALTER TABLE deliveries ADD COLUMN {name} {kind}')
        db.commit()
        yield db, fd
    finally:
        if 'db' in locals():
            db.close()
        os.close(fd)


def automatic_hold(runtime):
    if runtime != 'claude':
        return False
    fallback = Path(os.environ.get('AGENT_FALLBACK_STATE', str(Path(os.environ.get('XDG_STATE_HOME', str(Path.home()/'.local/state')))/'agent-fallback')))
    if os.path.lexists(fallback/'hold'):
        return True
    mode = fallback/'mode'
    if mode.exists():
        value = mode.read_text().strip()
        if value not in ('claude', 'codex'):
            raise ValueError('invalid fallback mode; delivery refused')
        return value == 'codex'
    return False


def effective(db, runtime):
    modes = dict(db.execute('SELECT scope,mode FROM policy'))
    configured = modes.get(runtime, modes.get('all', 'on'))
    if configured == 'off':
        return 'off'
    return 'queue' if automatic_hold(runtime) else configured


def expire(db):
    db.execute("UPDATE deliveries SET status='expired',payload=NULL WHERE status='queued' AND expires<=?", (time.time(),))
    db.commit()


def status(db):
    expire(db)
    return {'configured': dict(db.execute('SELECT scope,mode FROM policy')),
            'effective': {r: effective(db, r) for r in ('claude', 'codex')},
            'counts': dict(db.execute('SELECT status,count(*) FROM deliveries GROUP BY status')),
            'ledger_sequence': db.execute('SELECT coalesce(max(seq),0) FROM ledger').fetchone()[0]}


def validate(spec):
    spec = dict(spec)
    if spec.get('kind') == 'native':
        spec.setdefault('resume', False)
    if spec.get('kind') not in ('native', 'tmux', 'inbox') or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', str(spec.get('runtime', ''))):
        raise ValueError('unsupported comms transport/runtime')
    if not isinstance(spec.get('destination'), str) or not spec['destination']:
        raise ValueError('destination required')
    if len(encode(spec).encode()) > 1048576:
        raise ValueError('comms message exceeds one MiB')
    return spec


def controller_origin(spec, db):
    if spec['kind'] == 'inbox':
        for line in spec['batch']:
            try:
                record = json.loads(line.removeprefix('AGENT_MESH_INBOX '))
            except ValueError:
                return False
            if not isinstance(record, dict) or not isinstance(record.get('prompt'), str):
                return False
            permit = db.execute('SELECT destination,body_digest,origin,expires FROM deliveries WHERE id=?',
                                (record.get('commsPermit'),)).fetchone()
            if not permit or permit[0] != spec['destination'] or permit[2] != 'controller' or permit[3] <= time.time():
                return False
            if permit[1] != hashlib.sha256(record['prompt'].encode()).hexdigest():
                return False
        return bool(spec['batch'])
    claim = os.environ.get('PROJECT_DIRECTOR_GUARD_CLAIM')
    guard = os.environ.get('PROJECT_DIRECTOR_GUARD_PID', '')
    if not claim or not guard.isdecimal():
        return False
    # A role-run ancestor is required, not a label in the message or an MCP argument.
    current = os.getppid()
    for _ in range(32):
        if current == int(guard):
            break
        try:
            current = int((Path('/proc')/str(current)/'stat').read_text().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            return False
        if current <= 1:
            return False
    else:
        return False
    # A nonce emitted by the actual role-run process binds this invocation.
    graph = Path(os.environ.get('MESH_GRAPH_STATE', str(Path(os.environ.get('XDG_STATE_HOME', str(Path.home()/'.local/state')))/'agent-mesh/graph')))/'graph.json'
    proof = json.loads((graph.parent/'graph.lock/comms-guard.json').read_text()) if (graph.parent/'graph.lock/comms-guard.json').exists() else {}
    token = os.environ.get('MESH_COMMS_GUARD_TOKEN', '')
    if (proof.get('pid') != int(guard) or proof.get('start') != process_start(int(guard)) or
            proof.get('claim') != claim or not token or
            not hmac.compare_digest(proof.get('tokenHash', ''), hashlib.sha256(token.encode()).hexdigest())):
        return False
    data = json.loads(graph.read_text())
    return any(c.get('id') == claim and c.get('role') == 'global-controller'
               and c.get('project') == 'global' and c.get('status') == 'active'
               and datetime.fromisoformat(c['expiresAt'].replace('Z', '+00:00')).timestamp() > time.time()
               for c in data.get('roleClaims', []))


def process_start(pid):
    return (Path('/proc')/str(pid)/'stat').read_text().rsplit(')', 1)[1].split()[19]


def replaying(spec):
    spec = validate(spec)
    if 'MESH_COMMS_REPLAY_FD' not in os.environ:
        return None
    fd = int(os.environ['MESH_COMMS_REPLAY_FD'])
    if not stat.S_ISFIFO(os.fstat(fd).st_mode):
        raise ValueError('replay requires a dispatcher capability pipe')
    cap = json.loads(os.read(fd, 2048))
    db = sqlite3.connect(root()/'comms.sqlite')
    try:
        row = db.execute('SELECT digest,status,cap_hash,dispatcher_pid,dispatcher_start,cap_used,expires FROM deliveries WHERE id=?', (cap.get('id'),)).fetchone()
        if (not row or row[1] != 'unknown' or row[5] != 0 or row[6] <= time.time() or
                row[0] != hashlib.sha256(encode(spec).encode()).hexdigest() or
                not hmac.compare_digest(row[2] or '', hashlib.sha256(cap.get('token','').encode()).hexdigest()) or
                process_start(row[3]) != row[4]):
            raise ValueError('invalid or stale payload-bound replay capability')
        current = os.getppid()
        for _ in range(32):
            if current == row[3]: break
            current = int((Path('/proc')/str(current)/'stat').read_text().rsplit(')',1)[1].split()[1])
            if current <= 1: raise ValueError('replay dispatcher is not an ancestor')
        else:
            raise ValueError('replay dispatcher is not an ancestor')
        changed = db.execute('UPDATE deliveries SET cap_used=1 WHERE id=? AND cap_used=0', (cap['id'],)).rowcount
        db.commit()
        if changed != 1: raise ValueError('replay capability already consumed')
        return {'status':'send', 'id':cap['id'], 'completionToken':cap['token']}
    finally:
        db.close()


def replay_complete(receipt, accepted=False, rejected=False):
    db = sqlite3.connect(root()/'comms.sqlite')
    try:
        row = db.execute('SELECT cap_hash,cap_used,dispatcher_pid,dispatcher_start FROM deliveries WHERE id=?', (receipt['id'],)).fetchone()
        if (not row or row[1] != 1 or process_start(row[2]) != row[3] or
                not hmac.compare_digest(row[0] or '', hashlib.sha256(receipt['completionToken'].encode()).hexdigest())):
            raise ValueError('invalid replay completion capability')
        if accepted and rejected: raise ValueError('contradictory replay completion')
        state = 'delivered' if accepted else 'refused' if rejected else 'unknown'
        db.execute('UPDATE deliveries SET status=?,cap_used=2,payload=CASE WHEN ? THEN NULL ELSE payload END WHERE id=?',
                   (state, state != 'unknown', receipt['id']))
        db.commit()
    finally: db.close()


def identity(spec):
    destination = [spec['kind'], spec['runtime'], spec['destination'], spec.get('socket'), spec.get('correlation') or encode(spec)]
    return hashlib.sha256(encode(destination).encode()).hexdigest()


def command(spec):
    if spec['kind'] == 'native':
        args = ['node', str(BIN/'agent-native-call.mjs'), '--agent', spec['runtime'], '--session', spec['destination'],
                '--correlation-id', spec['correlation'], '--message', spec['message'], '--delivery-only']
        if spec.get('inbox_root'):
            args += ['--managed-inbox-root', spec['inbox_root']]
        if spec.get('resume'):
            args += ['--resume']
        return args
    if spec['kind'] == 'tmux':
        args = [str(BIN/'agent-send.sh'), '--agent', spec['runtime'], '--quiet', '--submit-only']
        if spec.get('correlation'):
            args += ['--correlation-id', spec['correlation'], '--result-token', spec['result_token']]
        return args + [spec['destination'], spec['message'], str(spec.get('timeout', 120))]
    return [sys.executable, str(BIN/'agent-inbox-native.py'), '--replay']


def refresh(db):
    if db.execute("SELECT 1 FROM auto_release WHERE scope='claude'").fetchone() and not automatic_hold('claude'):
        db.execute("INSERT OR REPLACE INTO policy VALUES ('claude','on')")
        db.execute("DELETE FROM auto_release WHERE scope='claude'")
        db.execute('INSERT INTO ledger(at,action,scope,reason,actor) VALUES (?,?,?,?,?)',
                   (time.time(), 'on', 'claude', 'fallback returned; release quota-linked queue', 'fallback'))
        db.commit()


def flush(db, fd):
    """Ordered per runtime. Persist unknown outcomes before any irreversible enqueue."""
    refresh(db)
    expire(db)
    # Legacy overlays can admit safely but must leave replay to a full dispatcher.
    if (BIN/'comms-no-replay').exists():
        return 0
    delivered = 0
    for seq, ident, runtime, payload in db.execute("SELECT seq,id,runtime,payload FROM deliveries WHERE status='queued' ORDER BY seq").fetchall():
        if effective(db, runtime) != 'on':
            continue
        # An earlier uncertain send blocks that runtime; never retry it blindly.
        if db.execute("SELECT 1 FROM deliveries WHERE runtime=? AND seq<? AND status='unknown' AND detail LIKE 'queued dispatch%'", (runtime, seq)).fetchone():
            continue
        spec = json.loads(payload)
        db.execute("UPDATE deliveries SET status='unknown',detail='queued dispatch started; inspect before retry' WHERE id=?", (ident,))
        db.commit()
        token = os.urandom(32).hex()
        reader, writer = os.pipe()
        os.write(writer, encode({'id':ident, 'token':token}).encode()); os.close(writer)
        db.execute('UPDATE deliveries SET cap_hash=?,dispatcher_pid=?,dispatcher_start=?,cap_used=0 WHERE id=?',
                   (hashlib.sha256(token.encode()).hexdigest(), os.getpid(), process_start(os.getpid()), ident)); db.commit()
        env = {**os.environ, 'MESH_COMMS_REPLAY_FD': str(reader)}
        if spec.get('socket'):
            env['MESH_TMUX_SOCKET'] = spec['socket']
        try:
            result = subprocess.run(command(spec), input=encode(spec) if spec['kind'] == 'inbox' else None,
                                    text=True, capture_output=True, timeout=90, env=env, pass_fds=(reader,))
            if result.returncode == 0:
                db.execute("UPDATE deliveries SET status='delivered',payload=NULL,detail='transport accepted' WHERE id=?", (ident,))
                db.commit()
                delivered += 1
            elif db.execute('SELECT status FROM deliveries WHERE id=?', (ident,)).fetchone()[0] not in ('refused','delivered'):
                break
        except (OSError, subprocess.SubprocessError):
            break
        finally:
            os.close(reader)
            db.execute('UPDATE deliveries SET cap_hash=NULL WHERE id=?', (ident,)); db.commit()
    return delivered


def admit(db, spec):
    spec = validate(spec)
    ident, digest = identity(spec), hashlib.sha256(encode(spec).encode()).hexdigest()
    mode = effective(db, spec['runtime'])
    exempt = controller_origin(spec, db)
    if mode == 'off' and not exempt:
        raise ValueError('inter-session communications are off; message rejected, nothing stored')
    previous = db.execute('SELECT digest,status FROM deliveries WHERE id=?', (ident,)).fetchone()
    if previous:
        if previous[0] != digest:
            raise ValueError('correlation reused with different payload')
        if previous[1] == 'unknown':
            raise ValueError('delivery outcome unknown; inspect, never retry blindly')
        return {'status': previous[1], 'id': ident, 'duplicate': True}
    if db.execute("SELECT count(*) FROM deliveries WHERE status IN ('queued','unknown')").fetchone()[0] >= 1000:
        raise ValueError('comms queue full')
    now = time.time()
    pending = db.execute("SELECT 1 FROM deliveries WHERE runtime=? AND (status='queued' OR (status='unknown' AND detail LIKE 'queued dispatch%'))", (spec['runtime'],)).fetchone()
    state = 'unknown' if exempt or (mode == 'on' and not pending) else 'queued'
    db.execute('INSERT INTO deliveries(id,runtime,digest,payload,origin,created,expires,status,destination,body_digest) VALUES (?,?,?,?,?,?,?,?,?,?)',
               (ident, spec['runtime'], digest, encode(spec), 'controller' if exempt else 'peer', now,
                now + min(max(int(spec.get('ttl', 86400)), 1), 604800), state, spec['destination'],
                hashlib.sha256(spec.get('message', '').encode()).hexdigest()))
    db.commit()
    return {'status': 'send' if state == 'unknown' else 'queued', 'id': ident}


def lease(spec):
    replay = replaying(spec)
    if replay:
        print(encode(replay), flush=True)
        result = json.loads(sys.stdin.readline())
        replay_complete(replay, result.get('accepted') is True, result.get('rejected') is True)
        return
    with locked() as (db, fd):
        flush(db, fd)
        receipt = admit(db, spec)
        print(encode(receipt), flush=True)
        if receipt['status'] != 'send':
            return
        try:
            result = json.loads(sys.stdin.readline())
        except (ValueError, OSError):
            result = {}
        # Only explicit transport acceptance resolves uncertainty.
        if result.get('rejected') is True:
            db.execute("UPDATE deliveries SET status='refused',payload=NULL,detail='proven pre-enqueue refusal' WHERE id=?", (receipt['id'],)); db.commit()
        if result.get('accepted') is True:
            db.execute("UPDATE deliveries SET status='delivered',payload=NULL,detail='transport accepted' WHERE id=?", (receipt['id'],))
            db.commit()


def change(mode, scope, reason, actor):
    if mode not in ('on', 'queue', 'off') or scope not in ('all', 'claude', 'codex') or not reason or not actor:
        raise ValueError('mode, scope, reason and by are required')
    with locked() as (db, fd):
        db.execute('INSERT OR REPLACE INTO policy VALUES (?,?)', (scope, mode))
        if scope == 'claude' and mode == 'queue' and automatic_hold('claude'):
            db.execute("INSERT OR REPLACE INTO auto_release VALUES ('claude')")
        elif scope in ('all', 'claude'):
            db.execute('DELETE FROM auto_release')
        if scope == 'all':
            db.execute("DELETE FROM policy WHERE scope!='all'")
        db.execute('INSERT INTO ledger(at,action,scope,reason,actor) VALUES (?,?,?,?,?)', (time.time(), mode, scope, reason, actor))
        db.commit()
        if mode == 'on':
            flush(db, fd)
        return status(db)


def mcp():
    """Local stdio MCP control surface; no message-origin assertions accepted."""
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        try:
            method, args = request['method'], request.get('params', {})
            if method == 'initialize':
                value = {'protocolVersion': args.get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}},
                         'serverInfo': {'name': 'agent-mesh-comms', 'version': '1.0.0'}}
            elif method == 'tools/list':
                value = {'tools': [{'name': 'mesh_comms', 'description': 'Read or change the local inter-session communication gate.',
                    'inputSchema': {'type': 'object', 'properties': {'action': {'enum': ['status', 'on', 'queue', 'off', 'sync']},
                    'scope': {'enum': ['all', 'claude', 'codex']}, 'reason': {'type': 'string'}, 'by': {'type': 'string'}}, 'required': ['action']}}]}
            elif method == 'tools/call' and args.get('name') == 'mesh_comms':
                data = args.get('arguments', {})
                if data['action'] in ('on', 'queue', 'off'):
                    result = change(data['action'], data.get('scope', 'all'), data.get('reason'), data.get('by'))
                else:
                    with locked() as (db, fd):
                        if data['action'] == 'sync':
                            flush(db, fd)
                        elif data['action'] != 'status':
                            raise ValueError('unknown comms action')
                        result = status(db)
                value = {'content': [{'type': 'text', 'text': encode(result)}]}
            elif method == 'ping':
                value = {}
            else:
                raise ValueError('unknown method')
            print(encode({'jsonrpc': '2.0', 'id': request['id'], 'result': value}), flush=True)
        except (ValueError, KeyError, OSError) as error:
            print(encode({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32602, 'message': str(error)}}), flush=True)


class Gate:
    """Hold the delivery lock only through enqueue, never through model execution."""
    def __init__(self, spec):
        self.spec = spec
        self.accepted = False
        self.rejected = False
        self.process = None
        self.replay = False

    def __enter__(self):
        replay = replaying(self.spec)
        if replay:
            self.receipt = replay
            self.replay = True
        else:
            self.process = subprocess.Popen([sys.executable, str(BIN/'mesh-comms.py'), 'lease'],
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.process.stdin.write(encode(self.spec)+'\n'); self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                error = self.process.stderr.read()
                self.process.stdin.close(); self.process.wait()
                self.process.stdout.close(); self.process.stderr.close()
                raise ValueError(error or 'comms gate failed')
            self.receipt = json.loads(line)
        self.send = self.receipt['status'] == 'send'
        return self

    def __exit__(self, *_args):
        if self.replay:
            replay_complete(self.receipt, self.accepted, self.rejected)
        if self.process:
            try:
                self.process.stdin.write(encode({'accepted': self.accepted, 'rejected': self.rejected})+'\n')
                self.process.stdin.flush()
            except BrokenPipeError:
                pass
            self.process.stdin.close()
            self.process.wait()
            self.process.stdout.close()
            self.process.stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'on', 'queue', 'off', 'sync', 'lease', 'verify', 'complete', 'mcp'])
    parser.add_argument('--scope', choices=['all', 'claude', 'codex'], default='all')
    parser.add_argument('--reason')
    parser.add_argument('--by')
    parser.add_argument('--request')
    args = parser.parse_args()
    if args.action == 'mcp':
        mcp()
    elif args.action == 'complete':
        result = json.loads(args.request)
        replay_complete(result, result.get('accepted') is True, result.get('rejected') is True)
    elif args.action == 'verify':
        print(encode(replaying(json.loads(args.request if args.request is not None else sys.stdin.readline()))))
    elif args.action == 'lease':
        lease(json.loads(args.request if args.request is not None else sys.stdin.readline()))
    elif args.action in ('on', 'queue', 'off'):
        print(encode(change(args.action, args.scope, args.reason, args.by)))
    else:
        with locked() as (db, fd):
            if args.action == 'sync':
                flush(db, fd)
            print(encode(status(db)))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print('mesh-comms: ' + str(error), file=sys.stderr)
        sys.exit(78)
