#!/usr/bin/env python3
"""Create an in-memory, sealed ZIP from a previously observed plugin tree.

The caller must keep the descriptor alive, authenticate the expected digest,
and control extraction and runtime access. This is not an authority check or
proof that an extracted plugin remains immutable.
"""
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import zipfile

MAX_ENTRIES = 10000
MAX_BYTES = 64 * 1024 * 1024
SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL


def _stamp(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def sealed_plugin_snapshot(root, expected_sha256):
    if not isinstance(root, str) or not os.path.isabs(root) or os.path.realpath(root) != root or not re.fullmatch(r'[a-f0-9]{64}', expected_sha256 or ''):
        raise ValueError('invalid plugin snapshot request')
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    output = io.BytesIO()
    records = []
    count = 0
    total = 0
    try:
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            def visit(directory_fd, relative, depth):
                nonlocal count, total
                count += 1
                if count > MAX_ENTRIES or depth > 128:
                    raise ValueError('plugin tree exceeds limits')
                before = os.fstat(directory_fd)
                if not stat.S_ISDIR(before.st_mode):
                    raise ValueError('plugin directory changed')
                records.append(['dir', relative, str(before.st_mode & 0o777)])
                if relative:
                    info = zipfile.ZipInfo(relative + '/')
                    info.external_attr = (stat.S_IFDIR | (before.st_mode & 0o777)) << 16 | 0x10
                    archive.writestr(info, b'')
                names = os.listdir(directory_fd)
                try:
                    names.sort(key=lambda name: name.encode('utf-8', 'strict'))
                except UnicodeError as exc:
                    raise ValueError('invalid plugin filename') from exc
                for name in names:
                    if '\ufffd' in name or '\\' in name:
                        raise ValueError('invalid plugin filename')
                    path = relative + '/' + name if relative else name
                    child = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if stat.S_ISDIR(child.st_mode):
                        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd)
                        try:
                            if _stamp(os.fstat(fd)) != _stamp(child):
                                raise ValueError('plugin directory changed')
                            visit(fd, path, depth + 1)
                        finally:
                            os.close(fd)
                        continue
                    count += 1
                    if count > MAX_ENTRIES or depth + 1 > 128 or not stat.S_ISREG(child.st_mode) or child.st_nlink != 1 or child.st_size > MAX_BYTES or total + child.st_size > MAX_BYTES:
                        raise ValueError('unsupported plugin file')
                    total += child.st_size
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory_fd)
                    try:
                        if _stamp(os.fstat(fd)) != _stamp(child):
                            raise ValueError('plugin file changed')
                        data = bytearray()
                        while len(data) < child.st_size:
                            part = os.read(fd, min(1024 * 1024, child.st_size - len(data)))
                            if not part:
                                raise ValueError('plugin file truncated')
                            data.extend(part)
                        if _stamp(os.fstat(fd)) != _stamp(child) or _stamp(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)) != _stamp(child):
                            raise ValueError('plugin file changed')
                        records.append(['file', path, str(child.st_mode & 0o777), str(child.st_size), hashlib.sha256(data).hexdigest()])
                        info = zipfile.ZipInfo(path)
                        info.external_attr = (stat.S_IFREG | (child.st_mode & 0o777)) << 16
                        info.compress_type = zipfile.ZIP_DEFLATED
                        archive.writestr(info, data)
                    finally:
                        os.close(fd)
                if _stamp(os.fstat(directory_fd)) != _stamp(before):
                    raise ValueError('plugin directory changed')
            visit(rootfd, '', 0)
        current = os.lstat(root)
        if _stamp(current) != _stamp(os.fstat(rootfd)):
            raise ValueError('plugin root changed')
        encoded = json.dumps(records, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        if hashlib.sha256(encoded).hexdigest() != expected_sha256:
            raise ValueError('plugin tree digest mismatch')
        descriptor = os.memfd_create('agent-mesh-plugin-zip', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
        try:
            data = output.getvalue()
            offset = 0
            while offset < len(data):
                written = os.write(descriptor, data[offset:])
                if written <= 0:
                    raise OSError('snapshot write incomplete')
                offset += written
            fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, SEALS)
            os.lseek(descriptor, 0, os.SEEK_SET)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise
    finally:
        os.close(rootfd)
