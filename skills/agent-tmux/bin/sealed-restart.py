#!/usr/bin/env python3
"""Create a sealed, process-local snapshot of already authorized restart bytes.

This does not authenticate the receipt, validate YAML, start a session, or prove
that any launcher consumed the descriptor. The caller owns those steps and the fd.
"""
import fcntl
import hashlib
import os
import re
import stat


_FILENAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
_DIGEST = re.compile(r'^[a-f0-9]{64}$')
_MAX_BYTES = 1024 * 1024


def sealed_restart_snapshot(root, filename, expected_sha256):
    if not isinstance(root, str) or not os.path.isabs(root) or os.path.realpath(root) != root:
        raise ValueError('restart root must be absolute and canonical')
    if not isinstance(filename, str) or not _FILENAME.fullmatch(filename) or not isinstance(expected_sha256, str) or not _DIGEST.fullmatch(expected_sha256):
        raise ValueError('invalid restart snapshot binding')
    if not hasattr(os, 'memfd_create') or not hasattr(fcntl, 'F_ADD_SEALS'):
        raise RuntimeError('sealed memory unavailable')
    root_info = os.lstat(root)
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.getuid() or root_info.st_mode & 0o077:
        raise ValueError('restart root must be private and owned')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    source = None
    snapshot = None
    try:
        opened_root = os.fstat(directory)
        if (opened_root.st_dev, opened_root.st_ino) != (root_info.st_dev, root_info.st_ino):
            raise ValueError('restart root changed')
        source = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        before = os.fstat(source)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o077 or not 0 < before.st_size <= _MAX_BYTES:
            raise ValueError('invalid restart file')
        data = bytearray()
        while len(data) <= _MAX_BYTES:
            part = os.read(source, min(65536, _MAX_BYTES + 1 - len(data)))
            if not part:
                break
            data.extend(part)
        after = os.fstat(source)
        current = os.stat(filename, dir_fd=directory, follow_symlinks=False)
        root_after = os.lstat(root)
        fingerprint = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if not stat.S_ISREG(current.st_mode) or fingerprint(before) != fingerprint(after) or fingerprint(after) != fingerprint(current) or (root_after.st_dev, root_after.st_ino) != (opened_root.st_dev, opened_root.st_ino) or len(data) != before.st_size:
            raise ValueError('restart file changed during snapshot')
        if hashlib.sha256(data).hexdigest() != expected_sha256:
            raise ValueError('restart digest mismatch')
        snapshot = os.memfd_create('agent-mesh-restart', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        view = memoryview(data)
        while view:
            written = os.write(snapshot, view)
            if written <= 0:
                raise OSError('snapshot write incomplete')
            view = view[written:]
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(snapshot, fcntl.F_ADD_SEALS, seals)
        if fcntl.fcntl(snapshot, fcntl.F_GET_SEALS) & seals != seals or hashlib.sha256(os.pread(snapshot, len(data), 0)).hexdigest() != expected_sha256:
            raise RuntimeError('sealed snapshot verification failed')
        os.lseek(snapshot, 0, os.SEEK_SET)
        result = snapshot
        snapshot = None
        return result
    finally:
        if snapshot is not None:
            os.close(snapshot)
        if source is not None:
            os.close(source)
        os.close(directory)
