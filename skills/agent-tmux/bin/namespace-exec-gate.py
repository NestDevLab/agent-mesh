#!/usr/bin/env python3
"""Execute a trusted command only after an explicit private FIFO release.

This gate is a fail-closed coordination primitive, not an authorization boundary.
The caller owns the namespace, FIFO, command, environment and lifecycle.
"""
import os
from pathlib import Path
import stat
import sys


def main(argv):
    if len(argv) < 3 or argv[1] != '--' or not os.path.isabs(argv[0]) or not os.path.isabs(argv[2]):
        return 125
    fifo = Path(argv[0])
    try:
        parent = fifo.parent
        directory = parent.lstat()
        entry = fifo.lstat()
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077 or
                parent.resolve(strict=True) != parent or not stat.S_ISFIFO(entry.st_mode) or
                entry.st_uid != os.getuid() or entry.st_mode & 0o077 or entry.st_nlink != 1):
            return 125
        fd = os.open(fifo, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            if (not stat.S_ISFIFO(opened.st_mode) or opened.st_uid != os.getuid() or opened.st_mode & 0o077 or opened.st_nlink != 1 or
                    opened.st_dev != entry.st_dev or opened.st_ino != entry.st_ino):
                return 125
            permit = os.read(fd, 4)
        finally:
            os.close(fd)
        if permit != b'GO\n':
            return 125
        os.execv(argv[2], argv[2:])
    except OSError:
        return 125
    return 125


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
