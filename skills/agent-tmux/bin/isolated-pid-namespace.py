#!/usr/bin/env python3
"""Experimental, network-isolated PID namespace lease for owned processes.

No handover or session lifecycle uses this module. It is not an authorization
boundary and cannot undo remote effects. A caller must keep the lease alive.
"""
import errno
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time
import uuid

BWRAP = '/usr/bin/bwrap'
GATE = str(Path(__file__).resolve().with_name('namespace-exec-gate.py'))


def _identity(pid):
    proc = Path('/proc') / str(pid)
    meta = proc.stat()
    fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    status = (proc / 'status').read_text().splitlines()
    nested = next(line for line in status if line.startswith('NSpid:')).split()[1:]
    return meta.st_uid, int(fields[1]), fields[19], nested, (proc / 'ns/pid').stat().st_ino


def _pidfd_pid(fd):
    lines = Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines()
    return int(next(line for line in lines if line.startswith('Pid:')).split()[1])


class IsolatedNamespace:
    """An owned lease, prepared but not released; do not target external PIDs."""
    def __init__(self, process, pidfd, gatefd):
        self.process = process
        self._pidfd = pidfd
        self._gatefd = gatefd
        self._released = False
        self._stopped = False

    @classmethod
    def prepare(cls, workspace, command, *, timeout=5):
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise RuntimeError('pidfd support unavailable')
        root = Path(workspace)
        if not root.is_absolute() or root.resolve(strict=True) != root:
            raise ValueError('workspace must be canonical')
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('workspace must be private')
        if not isinstance(command, list) or not command or len(command) > 64 or not os.path.isabs(command[0]) or any(not isinstance(item, str) or not item or len(item) > 8192 or '\x00' in item for item in command) or isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 30:
            raise ValueError('invalid isolated command')
        fifo = root / f'.namespace-gate-{uuid.uuid4().hex}'
        os.mkfifo(fifo, 0o600)
        before = fifo.lstat()
        readfd, writefd = os.pipe()
        process = None
        pidfd = None
        gatefd = None
        verified = False
        try:
            args = [BWRAP, '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', str(root), str(root),
                    '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--unshare-net', '--die-with-parent',
                    '--info-fd', str(writefd), '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
                    '--chdir', str(root), sys.executable, '-B', GATE, str(fifo), '--', *command]
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       pass_fds=(writefd,), start_new_session=True)
            os.close(writefd)
            writefd = None
            deadline = time.monotonic() + timeout
            raw = b''
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([readfd], [], [], remaining)[0]:
                    raise RuntimeError('namespace information unavailable')
                chunk = os.read(readfd, 8193 - len(raw))
                if not chunk:
                    raise RuntimeError('incomplete namespace information')
                raw += chunk
                if len(raw) > 8192:
                    raise RuntimeError('invalid namespace information')
                try:
                    record = json.loads(raw)
                    break
                except json.JSONDecodeError:
                    continue
            pid, inode = record.get('child-pid'), record.get('pid-namespace')
            if isinstance(pid, bool) or not isinstance(pid, int) or pid < 2 or isinstance(inode, bool) or not isinstance(inode, int):
                raise RuntimeError('invalid namespace identity')
            first = _identity(pid)
            if first[0] != os.getuid() or first[1] != process.pid or first[3][-1:] != ['1'] or first[4] != inode or inode == Path('/proc/self/ns/pid').stat().st_ino:
                raise RuntimeError('namespace ownership unverified')
            pidfd = os.pidfd_open(pid)
            if _pidfd_pid(pidfd) != pid or _identity(pid) != first:
                raise RuntimeError('namespace identity changed')
            verified = True
            deadline = time.monotonic() + timeout
            while True:
                try:
                    gatefd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
                    break
                except OSError as exc:
                    if exc.errno != errno.ENXIO or time.monotonic() >= deadline:
                        raise
                    time.sleep(.01)
            opened = os.fstat(gatefd)
            if not stat.S_ISFIFO(opened.st_mode) or opened.st_uid != os.getuid() or opened.st_mode & 0o077 or opened.st_nlink != 1 or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise RuntimeError('gate identity changed')
            result = cls(process, pidfd, gatefd)
            pidfd = None
            return result
        except Exception as exc:
            # Never release the gate on error. If ownership was verified, the
            # pinned namespace init can be stopped without targeting another PID.
            if pidfd is not None:
                if verified:
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                os.close(pidfd)
            if gatefd is not None:
                os.close(gatefd)
            elif process is not None and not verified:
                # An empty writer makes the trusted gate refuse execution. Do
                # not touch a FIFO that no longer has the original identity.
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    abortfd = None
                    try:
                        abortfd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
                        opened = os.fstat(abortfd)
                        if not stat.S_ISFIFO(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                            break
                        break
                    except OSError as abort_error:
                        if abort_error.errno != errno.ENXIO:
                            break
                        time.sleep(.01)
                    finally:
                        if abortfd is not None:
                            os.close(abortfd)
            if process is not None:
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    # An unverified namespace may need operator reconciliation.
                    pass
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream:
                        stream.close()
            raise RuntimeError('isolated preparation failed; cleanup may be unverified') from exc
        finally:
            os.close(readfd)
            if writefd is not None:
                os.close(writefd)

    def release(self):
        if self._stopped or self._released or self._gatefd is None:
            raise RuntimeError('gate unavailable')
        try:
            if os.write(self._gatefd, b'GO\n') != 3:
                raise RuntimeError('gate release uncertain')
        finally:
            os.close(self._gatefd)
            self._gatefd = None
        self._released = True

    def stop(self, *, timeout=5):
        if self._stopped or self._pidfd is None or isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 30:
            raise RuntimeError('namespace lease unavailable')
        try:
            signal.pidfd_send_signal(self._pidfd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        poller = select.poll()
        poller.register(self._pidfd, select.POLLIN)
        if not poller.poll(int(timeout * 1000)):
            raise RuntimeError('namespace init exit unverified')
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError('namespace wrapper exit unverified') from exc
        if self._gatefd is not None:
            os.close(self._gatefd)
            self._gatefd = None
        os.close(self._pidfd)
        self._pidfd = None
        self._stopped = True
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream:
                stream.close()
        return {'schema': 'agent-mesh.isolated-namespace-stop.v1', 'status': 'init-exited',
                'descendants': 'unverified', 'remoteEffects': 'unverified'}
