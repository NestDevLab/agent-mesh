#!/usr/bin/env python3
"""Bound, read-only view of an existing private bridge launch journal.

Journal contents are claims by the writer, not authenticated authority. Hold
this lease while corroborating process and transcript evidence.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid


def _open_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        current = os.lstat(path)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1
                or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
            raise RuntimeError('invalid private launch file')
        return fd, info
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def launch_evidence(path, *, launch_id, target, socket, session):
    if (not isinstance(path, str) or not os.path.isabs(path) or not isinstance(socket, str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', socket)
            or not isinstance(target, str) or not re.fullmatch(r'[a-z0-9-]+', target)
            or not isinstance(session, str) or not session.startswith('claude:')):
        raise ValueError('invalid launch observation request')
    try:
        if str(uuid.UUID(launch_id)) != launch_id or str(uuid.UUID(session[7:])) != session[7:]:
            raise ValueError('noncanonical id')
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError('invalid launch identity') from exc
    path = Path(path)
    parent = path.parent
    info = parent.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or str(parent.resolve(strict=True)) != str(parent)):
        raise RuntimeError('launch directory is not private and canonical')
    lockfd, lockinfo = _open_private(str(path) + '.lock')
    filefd = None
    try:
        fcntl.flock(lockfd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        filefd, before = _open_private(path)
        if before.st_size > 16 * 1024 * 1024:
            raise RuntimeError('launch journal too large')
        with os.fdopen(os.dup(filefd), 'rb') as stream:
            raw = stream.read(16 * 1024 * 1024 + 1)
        if len(raw) != before.st_size or not raw.endswith(b'\n'):
            raise RuntimeError('launch journal incomplete')
        latest = None
        matching_ids = 0
        for line in raw.splitlines():
            item = json.loads(line)
            if not isinstance(item, dict):
                raise RuntimeError('invalid launch journal entry')
            if item.get('schema') == 'agent-mesh.bridge-launch-event.v1' and item.get('event') == 'launch.started' and item.get('launchId') == launch_id:
                matching_ids += 1
            if item.get('schema') != 'agent-mesh.bridge-launch-event.v1' or item.get('event') != 'launch.started' or item.get('tmuxTarget') != target:
                continue
            if item.get('tmuxSocket') is None:
                # A legacy launch on this target cannot be assigned to a socket.
                latest = None
            elif item.get('tmuxSocket') == socket:
                latest = item
        if (matching_ids != 1 or not latest or latest.get('launchId') != launch_id or latest.get('agent') != 'claude'
                or latest.get('requestedSessionId') != session[7:] or latest.get('threadId') is not None):
            raise RuntimeError('launch journal does not match reservation')
        receipt = {'schema': 'agent-mesh.claude-launch-observation.v1', 'launchId': launch_id,
                   'target': target, 'socket': socket, 'requestedSession': session}
        yield receipt
        after = os.fstat(filefd)
        current = os.lstat(path)
        current_lock = os.lstat(str(path) + '.lock')
        if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
                or (current_lock.st_dev, current_lock.st_ino) != (lockinfo.st_dev, lockinfo.st_ino)):
            raise RuntimeError('launch journal changed during observation')
    finally:
        if filefd is not None:
            os.close(filefd)
        os.close(lockfd)
