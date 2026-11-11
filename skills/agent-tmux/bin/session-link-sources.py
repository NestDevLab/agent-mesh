#!/usr/bin/env python3
"""Read local native session metadata. Never writes or contacts a provider."""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

BRIDGE = re.compile(r'^(?:cse|session)_[A-Za-z0-9]{1,128}$')

def bridge(value):
    return 'session_' + value.split('_', 1)[1] if isinstance(value, str) and BRIDGE.fullmatch(value) else None

def files(root, pattern):
    return sorted(root.glob(pattern)) if root.exists() else []

def read_json(path):
    return json.loads(path.read_text())

def collect(sessions):
    home = Path.home()
    root = Path(os.environ.get('CLAUDE_SESSION_ROOT', home / '.claude/projects'))
    pidroot = Path(os.environ.get('CLAUDE_SESSION_METADATA_ROOT', home / '.claude/sessions'))
    desktop = Path(os.environ.get('CLAUDE_DESKTOP_SESSION_ROOT', home / '.config/Claude/claude-code-sessions'))
    db = Path(os.environ.get('CODEX_STATE_DB', home / '.codex/state_5.sqlite'))
    desktop_rows = []
    for path in files(desktop, '*/*/local_*.json'):
        value = read_json(path)
        desktop_rows.append((path.stat().st_mtime_ns, str(path), value))
    desktop_rows.sort(reverse=True, key=lambda row: (row[0], row[1]))
    pidrows = []
    for path in files(pidroot, '*.json'):
        value = read_json(path)
        try:
            os.kill(int(value.get('pid', path.stem)), 0)
        except (ValueError, ProcessLookupError):
            continue
        pidrows.append((path.stat().st_mtime_ns, str(path), value))
    pidrows.sort(reverse=True, key=lambda row: (row[0], row[1]))
    result = {}
    connection = sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True) if db.exists() else None
    try:
        for session in sessions:
            agent, uuid = session.split(':', 1)
            if agent == 'codex':
                if connection is None:
                    result[session] = dict(status='missing', reason='native-store-unavailable')
                    continue
                row = connection.execute('SELECT archived FROM threads WHERE id = ?', (uuid,)).fetchone()
                result[session] = dict(status='dead', reason='thread-not-found') if row is None else dict(status='archived' if row[0] else 'ok', link=session, source='codex-threads')
                continue
            is_cloud = agent == 'claude-cloud'
            cloud_id = bridge(uuid.split(':', 1)[1]) if is_cloud else None
            matching = [row for _, _, row in desktop_rows if (row.get('cliSessionId') == uuid if not is_cloud else cloud_id in [bridge(v) for v in row.get('bridgeSessionIds', [])] or cloud_id == bridge(row.get('remoteControlSpawn', {}).get('ccrSessionId')))]
            chosen = None
            found_transcript = False
            if not is_cloud:
                candidates = sorted(files(root, f'*/{uuid}.jsonl'), key=lambda p: (p.stat().st_mtime_ns, str(p)))
                hits = []
                for path in candidates:
                    found_transcript = True
                    for index, line in enumerate(path.read_text().splitlines()):
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        value = bridge(record.get('bridgeSessionId'))
                        if value:
                            hits.append((str(record.get('timestamp') or ''), path.stat().st_mtime_ns, str(path), index, value))
                if hits:
                    chosen = (max(hits)[-1], 'claude-transcript')
                if chosen is None:
                    chosen = next(((bridge(v.get('bridgeSessionId')), 'claude-pidfile') for _, _, v in pidrows if v.get('sessionId') == uuid and bridge(v.get('bridgeSessionId'))), None)
            if chosen is None and matching:
                row = matching[0]
                ids = row.get('bridgeSessionIds', [])
                value = next((bridge(v) for v in reversed(ids) if bridge(v)), None) or bridge(row.get('remoteControlSpawn', {}).get('ccrSessionId'))
                if value:
                    chosen = (value, 'claude-desktop')
            if matching and matching[0].get('isArchived') is True:
                result[session] = dict(status='archived', link='https://claude.ai/code/' + chosen[0] if chosen else None, source='claude-desktop', reason='native-archived')
            elif chosen:
                result[session] = dict(status='ok', link='https://claude.ai/code/' + chosen[0], source=chosen[1], reason='local-link-evidence; remote-reachability-unverified')
            else:
                result[session] = dict(status='missing', reason='bridge-identity-unavailable' if found_transcript or matching else 'native-evidence-unavailable')
    finally:
        if connection:
            connection.close()
    return result

if __name__ == '__main__':
    print(json.dumps(collect(json.load(sys.stdin))))
