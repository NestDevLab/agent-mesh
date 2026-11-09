#!/usr/bin/env python3
"""Carry a decision request to a Director session and the owner's choice back.

Transport state only: the work item stays the record of what was decided.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

BIN = Path(__file__).resolve().parent
PENDING = 75
INVALID = 2
CLOUD_ACCEPTED = 'Sent to cloud session.'
CLOUD_SESSION = re.compile(r'session_[A-Za-z0-9_]+')


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), BIN / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


decisions, follow, inbox, notify, waker = (load(n) for n in (
    'agent-decisions', 'agent-follow', 'agent-session-inbox', 'agent-owner-notify', 'agent-waker'))


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def parse_ref(ref):
    agent, _, session = str(ref).partition(':')
    if agent == 'cloud' and CLOUD_SESSION.fullmatch(session):
        return agent, session
    native = follow.SESSION.fullmatch(str(ref))
    if native:
        return native[1].lower(), native[2].lower()
    raise ValueError(f'session ref must be claude:<uuid>, codex:<uuid> or cloud:<session id>: {ref}')


def transmit(ref, key, message, config):
    agent, session = parse_ref(ref)
    if agent == 'cloud':
        # Acceptance can be lost on timeout, so a retry may repeat: receivers dedupe on the decision id.
        try:
            result = subprocess.run(['claude', '-p', '--cloud', session, message], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0 and CLOUD_ACCEPTED in result.stdout.splitlines()
    if agent == 'codex':
        return waker.deliver('codex', session, key, message, None, False, resume=True) in waker.QUEUED
    root = Path(config.get('managedInboxRoot') or inbox.DEFAULT_ROOT)
    if notify.delivered(root, session, key):
        return True
    return notify.live(root, session) and waker.deliver('claude', session, key, message, str(root), True) in waker.QUEUED


def state_root(args, config):
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'agent-mesh' / 'decisions'
    root = Path(args.state or config.get('stateRoot') or base).expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    return root


def delivery_key(decision, phase, detail):
    return 'decision-' + hashlib.sha256(f'{decision}:{phase}:{detail}'.encode()).hexdigest()[:32]


def card_token(record):
    return record['hash'][:16]


def answer_command(record, args, root):
    command = [str(BIN / 'agent-decision.py')]
    if args.config:
        command += ['--config', str(args.config.resolve())]
    return shlex.join(command + ['--state', str(root.resolve()), 'answer', record['card']['id'],
                                 '--card-hash', card_token(record)])


def request_message(record, config, args, root):
    return (config.get('messagePrefix', '') + "Decision request for the owner. Show it once as one card with these "
            "options and keep the option ids. Silence isn't an answer.\n" +
            json.dumps({'card': record['card'], 'from': record['from']}, ensure_ascii=False) +
            f"\nOnce the owner picks: {answer_command(record, args, root)} --option <option id> "
            '--by <owner> --card <card message id> [--text "<their words, for the write-in option>"]')


def answer_message(record, config):
    card, choice = record['card'], record['answer']
    words = f" Their words: {choice['text']}" if choice['text'] else ''
    return (config.get('messagePrefix', '') + f"Decision answer for {card['id']}: {choice['by']} picked "
            f"\"{choice['label']}\" (option {choice['optionId']}) at {choice['at']} on card {choice['card']}. "
            f"Question: {card['question']}{words} This covers that one question only.")


def finish(root, record, outcome):
    notify.append(root / 'receipts.jsonl', {'id': record['card']['id'], 'outcome': outcome, 'recordedAt': now()})
    print(json.dumps({'id': record['card']['id'], 'outcome': outcome}))
    return PENDING if outcome.endswith('-pending') else 0


def send(args, config):
    target = args.to or config.get('target')
    if not target:
        raise ValueError('a target comes from --to or the config')
    parse_ref(target)
    parse_ref(args.origin)
    source = sys.stdin.read() if str(args.request) == '-' else args.request.read_text()
    card = decisions.make_request_card(json.loads(source), labels=config.get('labels'))
    digest = decisions.semantic_hash(card)
    root = state_root(args, config)
    path = root / (card['id'] + '.json')
    with follow.locked(root / (card['id'] + '.lock')):
        record = notify.read(path, None) or {'version': 1, 'hash': digest, 'card': card, 'from': args.origin,
                                             'to': target, 'createdAt': now(), 'sentAt': None, 'answer': None}
        if record['hash'] != digest or record['from'] != args.origin:
            raise ValueError(f"decision {card['id']} already exists with different content")
        if record['sentAt']:
            return finish(root, record, 'request-already-sent')
        record['to'] = target
        follow.atomic_json(path, record)
        if not transmit(target, delivery_key(card['id'], 'request', digest), request_message(record, config, args, root), config):
            return finish(root, record, 'request-pending')
        record['sentAt'] = now()
        follow.atomic_json(path, record)
        return finish(root, record, 'request-sent')


def answer(args, config):
    if not decisions.REQUEST_ID.fullmatch(args.id):
        raise ValueError('decision id must be 1-80 safe characters')
    if not (decisions._text(args.by) and decisions._text(args.card)):
        raise ValueError('--by and --card must not be blank')
    root = state_root(args, config)
    path = root / (args.id + '.json')
    with follow.locked(root / (args.id + '.lock')):
        record = notify.read(path, None)
        if not record or not record['sentAt']:
            raise ValueError(f'no sent decision with id {args.id}')
        if args.card_hash != card_token(record):
            raise ValueError(f'this answer belongs to a different card than decision {args.id}')
        option = decisions.resolve_answer(record['card'], args.option, args.text)
        at = decisions._stamp(decisions._instant(args.at)) if args.at else now()
        previous = record['answer']
        if previous and (previous['optionId'] != args.option or previous['text'] != args.text):
            raise ValueError(f'decision {args.id} already has a different answer')
        record['answer'] = previous or {'optionId': args.option, 'label': option['label'], 'text': args.text,
                                        'by': args.by, 'card': args.card, 'at': at, 'returnedAt': None}
        follow.atomic_json(path, record)
        if record['answer']['returnedAt']:
            return finish(root, record, 'answer-already-returned')
        detail = args.option + ':' + (args.text or '')
        if not transmit(record['from'], delivery_key(args.id, 'answer', detail), answer_message(record, config), config):
            return finish(root, record, 'answer-pending')
        record['answer']['returnedAt'] = now()
        follow.atomic_json(path, record)
        return finish(root, record, 'answer-returned')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--state', type=Path)
    commands = parser.add_subparsers(dest='command', required=True)
    sending = commands.add_parser('send')
    sending.add_argument('--request', type=Path, required=True, help="JSON request file, or - for stdin")
    sending.add_argument('--from', dest='origin', required=True, help='asking session ref')
    sending.add_argument('--to', help='Director session ref; defaults to the config target')
    answering = commands.add_parser('answer')
    answering.add_argument('id')
    answering.add_argument('--card-hash', required=True, help='the value printed in the request message')
    answering.add_argument('--option', required=True)
    answering.add_argument('--by', required=True)
    answering.add_argument('--card', required=True, help='id of the card message the owner answered')
    answering.add_argument('--text')
    answering.add_argument('--at', help='when the owner answered, ISO with a timezone')
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text()) if args.config else {}
        return (send if args.command == 'send' else answer)(args, config)
    except (ValueError, KeyError, OSError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return INVALID


if __name__ == '__main__':
    sys.exit(main())
