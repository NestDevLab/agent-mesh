#!/usr/bin/env python3
"""Fail-closed stdin gate for an owned experimental MCP probe process."""
import os
import sys


def main(argv):
    if len(argv) < 2 or argv[0] != '--' or not os.path.isabs(argv[1]):
        return 125
    permit = b''
    try:
        while len(permit) < 3:
            part = os.read(0, 3 - len(permit))
            if not part:
                return 125
            permit += part
        if permit != b'GO\n':
            return 125
        os.write(1, b'{"agentMeshMcpGate":"released"}\n')
        os.execv(argv[1], argv[1:])
    except OSError:
        return 125
    return 125


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
