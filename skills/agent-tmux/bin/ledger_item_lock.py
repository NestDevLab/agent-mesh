"""Host-local per-item leases. This module does not write ledger contents."""
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import uuid

SCHEMA = 'agent-mesh.ledger-item-lock.v1'
MAX_FENCE = (1 << 53) - 1  # JSON clients must be able to round-trip it exactly.
DEFAULT_TTL = 300
MAX_TTL = 3600
OWNER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}')
SCHEME = re.compile(r'[a-z][a-z0-9+.-]{0,63}')
LEASE_ID = re.compile(r'[0-9a-f]{32}')


class LeaseError(Exception):
    pass


class StaleLease(LeaseError):
    pass


def state_dir():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state'))
    return Path(os.environ.get('MESH_LEDGER_LOCK_STATE_DIR', base / 'agent-mesh/ledger-locks'))


def clock():
    # The deadline survives process exit, ignores wall-clock changes and includes
    # suspended time. A deadline from an earlier boot is never reused.
    if sys.platform != 'linux' or not hasattr(time, 'CLOCK_BOOTTIME'):
        raise LeaseError('item leases require a Linux boot clock')
    try:
        boot = str(uuid.UUID(Path('/proc/sys/kernel/random/boot_id').read_text().strip()))
        return boot, time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    except (OSError, ValueError):
        raise LeaseError('item lease clock unavailable') from None


def validate(ref, owner=None, fence=None, lease_id=None, ttl=None):
    scheme, _, item = ref.partition(':')
    if len(ref) > 512 or not SCHEME.fullmatch(scheme) or not item or any(
        ch.isspace() or not ch.isprintable() for ch in item
    ):
        raise LeaseError('invalid item ref')
    if owner is not None and not OWNER.fullmatch(owner):
        raise LeaseError('invalid lease owner')
    if fence is not None and (type(fence) is not int or not 0 <= fence <= MAX_FENCE):
        raise LeaseError('invalid fence')
    if lease_id is not None and not LEASE_ID.fullmatch(lease_id):
        raise LeaseError('invalid lease id')
    if ttl is not None and (type(ttl) is not int or not 1 <= ttl <= MAX_TTL):
        raise LeaseError('TTL must be 1 to 3600 seconds')


def private_path(path, expected):
    info = path.lstat()
    if (not expected(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077
            or stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
        raise LeaseError('item lease storage must be private and owned by the caller')


@contextmanager
def transaction(ref, directory, *, writable=False, create=False):
    root = Path(directory if directory is not None else state_dir()).absolute()
    path = root / (hashlib.sha256(ref.encode('utf-8')).hexdigest() + '.sqlite3')
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        private_path(root, stat.S_ISDIR)
        if create:
            try:
                os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600))
            except FileExistsError:
                pass
        private_path(path, stat.S_ISREG)
    except FileNotFoundError:
        if create:
            raise
        yield None
        return

    mode = 'rw' if writable else 'ro'
    with closing(sqlite3.connect(f'{path.as_uri()}?mode={mode}', uri=True, timeout=2,
                                 isolation_level=None)) as db:
        if writable:
            db.execute('PRAGMA synchronous = EXTRA')
        # SQLite holds the item transaction until commit or process exit. A
        # contender cannot remove or take over a stopped process's transaction.
        # Exclusive rollback-journal writers also keep inspect/check from
        # observing a pre-renewal snapshot halfway through the transition.
        db.execute('BEGIN EXCLUSIVE' if writable else 'BEGIN')
        if db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
            raise LeaseError('item lease storage requires rollback journaling')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version == 0:
            if not create:
                yield None
                return
            db.execute('''CREATE TABLE item_lease (
                slot INTEGER PRIMARY KEY CHECK (slot = 1),
                ref TEXT NOT NULL,
                fence INTEGER NOT NULL CHECK (fence > 0),
                owner TEXT,
                lease_id TEXT,
                boot TEXT,
                expires_ns INTEGER,
                CHECK ((owner IS NULL AND lease_id IS NULL AND boot IS NULL AND expires_ns IS NULL)
                    OR (owner IS NOT NULL AND lease_id IS NOT NULL AND boot IS NOT NULL AND expires_ns IS NOT NULL))
            )''')
            db.execute('PRAGMA user_version = 1')
        elif version != 1:
            raise LeaseError('unsupported item lease storage version')
        yield db
        db.commit()


def current(db, ref):
    if db is None:
        return 0, None, None, None, None
    row = db.execute('SELECT ref, fence, owner, lease_id, boot, expires_ns FROM item_lease WHERE slot = 1').fetchone()
    if row is None:
        return 0, None, None, None, None
    if row[0] != ref:
        raise LeaseError('item lease ref does not match storage')
    return row[1:]


def snapshot(ref, row, boot, now):
    fence, owner, _, old_boot, expires = row
    active = owner is not None and old_boot == boot and now < expires
    status = 'active' if active else 'expired' if owner is not None else 'available'
    value = {'schema': SCHEMA, 'ref': ref, 'fence': fence, 'status': status, 'owner': owner}
    if active:
        value['remainingMs'] = (expires - now + 999_999) // 1_000_000
    return value


def operation(name, ref, *, owner=None, fence=None, lease_id=None, ttl=None, directory=None):
    validate(ref, owner, fence, lease_id, ttl)
    writable = name in {'acquire', 'renew', 'release'}
    with transaction(ref, directory, writable=writable, create=name == 'acquire') as db:
        row = current(db, ref)
        # Sample only once the transaction has been obtained. Time spent waiting
        # for another writer cannot revive an already-expired lease.
        boot, now = clock()
        value = snapshot(ref, row, boot, now)
        if name == 'inspect':
            return value
        if name == 'acquire':
            if fence != value['fence'] or value['status'] == 'active':
                return {**value, 'outcome': 'conflict' if fence != value['fence'] else 'held'}
            if fence == MAX_FENCE:
                raise LeaseError('item fence exhausted')
            next_fence, next_id, expires = fence + 1, uuid.uuid4().hex, now + ttl * 1_000_000_000
            db.execute('''INSERT INTO item_lease VALUES (1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(slot) DO UPDATE SET fence=excluded.fence, owner=excluded.owner,
                    lease_id=excluded.lease_id, boot=excluded.boot, expires_ns=excluded.expires_ns
                ''', (ref, next_fence, owner, next_id, boot, expires))
            return {**snapshot(ref, (next_fence, owner, next_id, boot, expires), boot, now),
                    'outcome': 'acquired', 'leaseId': next_id}
        if value['status'] != 'active' or row[:3] != (fence, owner, lease_id):
            return {**value, 'outcome': 'stale'}
        if name == 'check':
            return {**value, 'outcome': 'current'}
        if name == 'renew':
            # A delayed short renewal must not cut short the same holder's lease.
            expires = max(row[4], now + ttl * 1_000_000_000)
            db.execute('UPDATE item_lease SET expires_ns=? WHERE slot=1', (expires,))
            return {**snapshot(ref, (*row[:4], expires), boot, now), 'outcome': 'renewed'}
        if name == 'release':
            db.execute('UPDATE item_lease SET owner=NULL, lease_id=NULL, boot=NULL, expires_ns=NULL WHERE slot=1')
            return {**snapshot(ref, (fence, None, None, None, None), boot, now), 'outcome': 'released'}
        raise LeaseError('unknown item lease operation')


@contextmanager
def guard_item_write(ref, *, owner, fence, lease_id, directory=None):
    """Hold the item's transaction across a bounded, synchronous local write."""
    validate(ref, owner, fence, lease_id)
    with transaction(ref, directory, writable=True) as db:
        row = current(db, ref)
        boot, now = clock()
        if snapshot(ref, row, boot, now)['status'] != 'active' or row[:3] != (fence, owner, lease_id):
            raise StaleLease('item lease is stale')
        yield


def add_parser(commands):
    lock = commands.add_parser('lock', help='manage a host-local item lease')
    operations = lock.add_subparsers(dest='lock_operation', required=True)
    for name in ('inspect', 'acquire', 'check', 'renew', 'release'):
        parser = operations.add_parser(name)
        parser.add_argument('--ref', required=True)
        parser.add_argument('--state', type=Path, help='override the private lease state directory')
        if name != 'inspect':
            parser.add_argument('--owner', required=True)
        if name == 'acquire':
            parser.add_argument('--expect-fence', dest='fence', type=int, required=True)
        elif name != 'inspect':
            parser.add_argument('--fence', type=int, required=True)
            parser.add_argument('--lease-id', required=True)
        if name in ('acquire', 'renew'):
            parser.add_argument('--ttl', type=int, default=DEFAULT_TTL, help='lease lifetime in seconds')


def cli(args):
    try:
        result = operation(args.lock_operation, args.ref, directory=args.state,
                           **{key: getattr(args, key, None) for key in ('owner', 'fence', 'lease_id', 'ttl')})
        code = 3 if result.get('outcome') in {'conflict', 'held', 'stale'} else 0
    except (LeaseError, OSError, sqlite3.Error) as error:
        code_family = getattr(error, 'sqlite_errorcode', 0) & 255
        busy = code_family in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
        result = {'schema': SCHEMA, 'outcome': 'busy' if busy else 'error',
                  'error': str(error) if isinstance(error, LeaseError) else
                  'item lease storage busy' if busy else 'item lease storage unavailable'}
        code = 1
    print(json.dumps(result, sort_keys=True))
    return code
