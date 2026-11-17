#!/usr/bin/env python3
"""Check sealed stdin and its digest, then decode it with the restart parser."""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import runpy
import stat
import sys

try:
    if len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{64}', sys.argv[1]):
        raise ValueError('invalid digest')
    info = os.fstat(0)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not 0 < info.st_size <= 1024 * 1024:
        raise ValueError('invalid sealed descriptor')
    seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    if fcntl.fcntl(0, fcntl.F_GET_SEALS) & seals != seals:
        raise ValueError('missing seals')
    content = os.pread(0, info.st_size, 0)
    if len(content) != info.st_size or hashlib.sha256(content).hexdigest() != sys.argv[1]:
        raise ValueError('digest mismatch')
    os.lseek(0, 0, os.SEEK_SET)
except (OSError, ValueError, AttributeError):
    print('invalid sealed restart snapshot', file=sys.stderr)
    sys.exit(1)
runpy.run_path(str(Path(__file__).with_name('restart-yaml.py')), run_name='__main__')
