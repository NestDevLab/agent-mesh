#!/usr/bin/env python3
"""Crash-conservative stop of an owned isolated successor.

This is not a handover controller or an authorization boundary. The caller
must bind the native assessment and owned stop callback to the same successor,
and consistently use the same private journal root for that session.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading


SESSION = re.compile(r'^codex:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)


def _open_private_root(root):
    if not isinstance(root, str) or not os.path.isabs(root) or str(Path(root).resolve(strict=True)) != root:
        raise ValueError('journal root must be absolute and canonical')
    before = os.lstat(root)
    if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
        raise ValueError('journal root must be private and owned')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
        os.close(fd)
        raise ValueError('journal root changed')
    return fd


def _verify_root(root, fd):
    current = os.lstat(root)
    opened = os.fstat(fd)
    if (not stat.S_ISDIR(current.st_mode) or current.st_uid != os.getuid() or current.st_mode & 0o077
            or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)):
        raise ValueError('journal root changed')


def _write_once(directory_fd, name, record):
    body = (json.dumps(record, separators=(',', ':'), sort_keys=True) + '\n').encode()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        view = memoryview(body)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError('journal write incomplete')
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(directory_fd)


class IsolatedRoleRollback:
    def __init__(self, expected_session, stop_owned_successor, journal_root):
        if not isinstance(expected_session, str) or not SESSION.fullmatch(expected_session) or expected_session != expected_session.lower() or not callable(stop_owned_successor):
            raise ValueError('invalid isolated successor binding')
        self._session = expected_session
        self._stop = stop_owned_successor
        self._journal_root = journal_root
        self._key = hashlib.sha256(expected_session.encode()).hexdigest()
        self._lock = threading.Lock()
        self._receipt = None

    def apply(self, assessment):
        if (not isinstance(assessment, dict) or assessment.get('schema') != 'agent-mesh.codex-role-start-assessment.v1'
                or assessment.get('session') != self._session or assessment.get('status') not in ('observed-incomplete', 'rollback-required')
                or not isinstance(assessment.get('failures'), list)
                or any(not isinstance(item, str) or not item for item in assessment['failures'])):
            raise ValueError('invalid or mismatched role assessment')
        if assessment['status'] == 'rollback-required' and not assessment['failures']:
            raise ValueError('rollback requires a stated failure')
        if assessment['status'] == 'observed-incomplete' and assessment['failures']:
            raise ValueError('inconsistent incomplete assessment')
        with self._lock:
            if self._receipt is not None:
                return copy.deepcopy(self._receipt)
            if assessment['status'] == 'observed-incomplete':
                return {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'blocked-incomplete',
                        'session': self._session, 'handover': 'blocked'}
            directory_fd = _open_private_root(self._journal_root)
            try:
                intent = {'schema': 'agent-mesh.isolated-role-stop-intent.v1', 'session': self._session}
                try:
                    _write_once(directory_fd, f'stop-{self._key}.intent.json', intent)
                except FileExistsError:
                    self._receipt = {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'stop-uncertain',
                                     'session': self._session, 'handover': 'blocked'}
                    return copy.deepcopy(self._receipt)
                _verify_root(self._journal_root, directory_fd)
                # Persist and fsync the attempt before the side effect. Never retry
                # automatically after a crash or an ambiguous callback result.
                self._receipt = {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'stop-uncertain',
                                 'session': self._session, 'handover': 'blocked'}
                try:
                    receipt = self._stop()
                except Exception:
                    receipt = None
                result = copy.deepcopy(self._receipt)
                if (isinstance(receipt, dict) and receipt.get('schema') == 'agent-mesh.isolated-namespace-stop.v1'
                        and receipt.get('status') == 'init-exited' and receipt.get('descendants') == 'unverified'
                        and receipt.get('remoteEffects') == 'unverified'):
                    result = {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'local-init-exited',
                              'session': self._session, 'handover': 'blocked',
                              'namespaceStop': {key: receipt[key] for key in ('schema', 'status', 'descendants', 'remoteEffects')}}
                try:
                    _write_once(directory_fd, f'stop-{self._key}.result.json', result)
                except OSError:
                    return copy.deepcopy(self._receipt)
                self._receipt = result
                return copy.deepcopy(self._receipt)
            finally:
                os.close(directory_fd)
