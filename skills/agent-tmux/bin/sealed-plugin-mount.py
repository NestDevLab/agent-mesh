#!/usr/bin/env python3
"""Prepare bubblewrap arguments for a private read-only plugin tmpfs.

This does not launch bubblewrap, authenticate a plugin, or provide a complete
sandbox. Use a descriptor from trusted sealed_plugin_snapshot and hold this
object until bubblewrap has inherited its file descriptors.
"""
import fcntl
import io
import os
from pathlib import PurePosixPath
import re
import stat
import zipfile

MAX_ENTRIES = 10000
MAX_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE = 128 * 1024 * 1024
SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL


class SealedPluginMount:
    def __init__(self, archive_fd, destination):
        if (type(archive_fd) is not int or not isinstance(destination, str) or not destination.startswith('/')
                or str(PurePosixPath(destination)) != destination or destination == '/' or '..' in PurePosixPath(destination).parts
                or any(c in destination for c in '\x00\r\n')):
            raise ValueError('invalid plugin mount request')
        if fcntl.fcntl(archive_fd, fcntl.F_GET_SEALS) & SEALS != SEALS:
            raise ValueError('plugin archive is not sealed')
        before = os.fstat(archive_fd)
        size = before.st_size
        if size <= 0 or size > MAX_ARCHIVE:
            raise ValueError('invalid plugin archive size')
        data = os.pread(archive_fd, size, 0)
        after = os.fstat(archive_fd)
        if (len(data) != size or (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size)
                or fcntl.fcntl(archive_fd, fcntl.F_GET_SEALS) & SEALS != SEALS):
            raise ValueError('incomplete or changed plugin archive')
        self._fds = []
        self._closed = False
        self.arguments = []
        seen = set()
        directories = {''}
        total = 0
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                match = re.fullmatch(rb'agent-mesh-root-mode:([0-7]{1,3})', archive.comment)
                if not match:
                    raise ValueError('plugin root mode missing')
                root_mode = match.group(1).decode('ascii')
                self.arguments += ['--perms', root_mode, '--dir', destination, '--perms', root_mode, '--tmpfs', destination]
                infos = archive.infolist()
                if len(infos) > MAX_ENTRIES:
                    raise ValueError('plugin archive exceeds entry limit')
                for info in infos:
                    name = info.filename.rstrip('/') if info.is_dir() else info.filename
                    parts = name.split('/')
                    if (not name or name.startswith('/') or '\\' in name or '\ufffd' in name
                            or any(not p or p in ('.', '..') for p in parts) or len(parts) > 128
                            or any(ord(c) < 32 for c in name) or name in seen):
                        raise ValueError('invalid plugin archive path')
                    parent = '/'.join(parts[:-1])
                    if parent not in directories:
                        raise ValueError('plugin archive parent unavailable')
                    seen.add(name)
                    mode = info.external_attr >> 16
                    permissions = format(mode & 0o777, 'o')
                    target = destination + '/' + name
                    if info.is_dir():
                        if not stat.S_ISDIR(mode) or info.file_size:
                            raise ValueError('invalid plugin directory entry')
                        directories.add(name)
                        self.arguments += ['--perms', permissions, '--dir', target]
                        continue
                    if not stat.S_ISREG(mode) or info.file_size > MAX_BYTES or total + info.file_size > MAX_BYTES:
                        raise ValueError('invalid plugin file entry')
                    total += info.file_size
                    contents = archive.read(info)
                    if len(contents) != info.file_size:
                        raise ValueError('incomplete plugin file entry')
                    fd = os.memfd_create('agent-mesh-plugin-file', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
                    self._fds.append(fd)
                    offset = 0
                    while offset < len(contents):
                        written = os.write(fd, contents[offset:])
                        if written <= 0:
                            raise OSError('plugin file write incomplete')
                        offset += written
                    fcntl.fcntl(fd, fcntl.F_ADD_SEALS, SEALS)
                    os.lseek(fd, 0, os.SEEK_SET)
                    self.arguments += ['--perms', permissions, '--file', str(fd), target]
            self.arguments += ['--remount-ro', destination]
        except BaseException:
            self.close()
            raise

    @property
    def pass_fds(self):
        if self._closed:
            raise RuntimeError('plugin mount lease is closed')
        return tuple(self._fds)

    def close(self):
        if not self._closed:
            self._closed = True
            for fd in self._fds:
                os.close(fd)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
