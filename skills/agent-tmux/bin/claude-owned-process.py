#!/usr/bin/env python3
"""Read-only process identity evidence for a caller-owned Claude launch.

The caller supplies a trusted executable and retains this lease while checking
other evidence. This does not authenticate a caller, prove global singleton
ownership, authorize a handover, or alter a process.
"""
import os
from pathlib import Path
import re
import select
import stat

SESSION = re.compile(r'^claude:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')


def _identity(pid):
    root = Path('/proc') / str(pid)
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    if fields[0] in ('Z', 'X', 'x'):
        raise RuntimeError('process has exited')
    return (root.stat().st_uid, int(fields[1]), fields[19])


def _alive(fd):
    poller = select.poll()
    poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    if poller.poll(0):
        raise RuntimeError('process has exited')


class OwnedClaudeProcess:
    """Hold pidfds for a writer and every ancestor up to its owning pane."""
    def __init__(self, writer_pid, pane_pid, session, trusted_executable):
        match = SESSION.fullmatch(session) if isinstance(session, str) else None
        if not match or any(type(p) is not int or p < 1 for p in (writer_pid, pane_pid)):
            raise ValueError('invalid process or session identity')
        if not hasattr(os, 'pidfd_open') or not os.path.isabs(trusted_executable):
            raise ValueError('pidfd and absolute trusted executable required')
        self.session = session
        self.writer_pid = writer_pid
        self.pane_pid = pane_pid
        self._expected_id = match.group(1).encode()
        self._executable = os.path.realpath(trusted_executable, strict=True)
        exe = os.stat(self._executable)
        if not stat.S_ISREG(exe.st_mode):
            raise ValueError('trusted executable is not a regular file')
        self._exe_id = (exe.st_dev, exe.st_ino)
        self._chain = []
        self._closed = False
        try:
            pid = writer_pid
            seen = set()
            while True:
                if pid in seen or len(seen) >= 32:
                    raise RuntimeError('invalid process ancestry')
                seen.add(pid)
                before = _identity(pid)
                fd = os.pidfd_open(pid, 0)
                self._chain.append((pid, fd, before))
                _alive(fd)
                if _identity(pid) != before:
                    raise RuntimeError('process identity changed')
                if pid == pane_pid:
                    break
                pid = before[1]
                if pid < 1:
                    raise RuntimeError('writer is not a pane descendant')
            self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self):
        if self._closed:
            raise RuntimeError('identity lease is closed')
        for pid, fd, expected in self._chain:
            _alive(fd)
            if _identity(pid) != expected:
                raise RuntimeError('process identity or ancestry changed')
        if self._chain[0][2][0] != os.getuid() or self._chain[-1][2][0] != os.getuid():
            raise RuntimeError('writer or pane has a different owner')
        proc = Path('/proc') / str(self.writer_pid)
        actual = (proc / 'exe').stat()
        expected = os.stat(self._executable)
        if (actual.st_dev, actual.st_ino) != self._exe_id or (expected.st_dev, expected.st_ino) != self._exe_id:
            raise RuntimeError('writer executable does not match trusted executable')
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        ids = []
        for index, arg in enumerate(args):
            if arg in (b'--resume', b'-r', b'--continue', b'-c', b'--fork-session') or arg.startswith((b'--resume=', b'--continue=', b'--fork-session=')):
                raise RuntimeError('writer uses an unsupported session mode')
            if arg == b'--session-id':
                ids.append(args[index + 1] if index + 1 < len(args) else b'')
            elif arg.startswith(b'--session-id='):
                ids.append(arg.split(b'=', 1)[1])
        if ids != [self._expected_id]:
            raise RuntimeError('writer session identity is not unique or does not match')
        for pid, fd, identity in self._chain:
            _alive(fd)
            if _identity(pid) != identity:
                raise RuntimeError('process identity or ancestry changed')
        return {'schema': 'agent-mesh.claude-owned-process.v1', 'session': self.session,
                'writerPid': self.writer_pid, 'writerStartTicks': self._chain[0][2][2],
                'panePid': self.pane_pid, 'paneStartTicks': self._chain[-1][2][2],
                'executableDevice': self._exe_id[0], 'executableInode': self._exe_id[1]}

    def close(self):
        if not self._closed:
            self._closed = True
            for _, fd, _ in self._chain:
                os.close(fd)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
