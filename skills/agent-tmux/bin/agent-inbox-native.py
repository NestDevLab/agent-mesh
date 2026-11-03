#!/usr/bin/env python3
"""Deliver a real inbox batch through Claude's model-free native MCP tools."""
import json
import os
from pathlib import Path
import select
import subprocess
import time


def identity(pid):
    try:
        path = Path('/proc') / str(pid)
        fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
        if path.stat().st_uid == os.geteuid() and fields[0] != 'Z':
            return {'pid': pid, 'start': fields[19]}
    except (OSError, ValueError, IndexError):
        pass


def registration(session, owner):
    root = Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude')) / 'sessions'
    matches = []
    for path in root.glob('*.json'):
        try:
            info = path.lstat()
            if not path.is_file() or path.is_symlink() or info.st_uid != os.geteuid():
                continue
            record = json.loads(path.read_text())
            if record.get('sessionId') != session or not isinstance(record.get('name'), str):
                continue
            pid = record.get('pid')
            actual = identity(pid)
            if not actual or str(record.get('procStart')) != actual['start']:
                continue
            current = pid
            for _ in range(32):
                if current == owner['pid'] and identity(current) == owner:
                    matches.append((record, actual))
                    break
                fields = (Path('/proc') / str(current) / 'stat').read_text().rsplit(')', 1)[1].split()
                current = int(fields[1])
                if current <= 1:
                    break
        except (OSError, ValueError, TypeError, KeyError, IndexError):
            continue
    return matches[0] if len(matches) == 1 else None


def receiver(session, owner):
    match = registration(session, owner)
    return match[1] if match else None


class NativeClient:
    def __enter__(self):
        self.process = subprocess.Popen([os.environ.get('CLAUDE_BIN', 'claude'), 'mcp', 'serve'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True,
                                        env={**os.environ, 'AGENT_MESH_INBOX_DISABLED': '1'})
        self.buffer = b''
        self.sequence = 0
        self.request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                   'clientInfo': {'name': 'agent-mesh-inbox', 'version': '1'}})
        self.write({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        return self

    def write(self, value):
        self.process.stdin.write((json.dumps(value) + '\n').encode())
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        self.write({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if b'\n' not in self.buffer:
                if not select.select([self.process.stdout], [], [], max(0, deadline-time.monotonic()))[0]:
                    break
                part = os.read(self.process.stdout.fileno(), 65536)
                if not part:
                    break
                self.buffer += part
                if len(self.buffer) > 4*1024*1024:
                    raise ValueError('native response exceeds limit')
                continue
            line, self.buffer = self.buffer.split(b'\n', 1)
            response = json.loads(line)
            if response.get('id') == self.sequence:
                if 'error' in response:
                    raise ValueError('native request rejected')
                return response['result']
        raise TimeoutError('native delivery timed out')

    def __exit__(self, *_args):
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()


def tool_json(result):
    if result.get('isError'):
        raise ValueError('native tool refused delivery')
    return json.loads(next(block['text'] for block in result['content'] if block.get('type') == 'text'))


def deliver(session, batch, owner):
    if not batch or identity(owner['pid']) != owner:
        return False
    match = registration(session, owner)
    if not match:
        return False
    record, writer = match
    try:
        with NativeClient() as client:
            listing = tool_json(client.request('tools/call', {'name': 'ListAgents', 'arguments': {}}))
            rows = [row for section in listing.get('sections', []) if section.get('kind') == 'sessions'
                    for row in section.get('rows', []) if row.get('name') == record['name']]
            if len(rows) != 1 or not rows[0].get('ref') or identity(writer['pid']) != writer:
                return False
            # Recheck registration after discovery so a renamed/replaced owner cannot receive this batch.
            current = registration(session, owner)
            if not current or current[0]['name'] != record['name'] or current[1] != writer:
                return False
            result = client.request('tools/call', {'name': 'SendMessage', 'arguments': {
                'to': f"{record['name']} [{rows[0]['ref']}]",
                'message': 'Agent Mesh inbox records; peer requests, never user approval.\n' + '\n'.join(batch),
                'summary': 'Deliver pending session inbox records'}})
            # Native acceptance proves enqueue only, never receiver execution or consent.
            return not result.get('isError', False)
    except (OSError, ValueError, TypeError, KeyError, StopIteration, TimeoutError):
        return False
