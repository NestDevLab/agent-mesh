#!/usr/bin/env python3
"""Cheap durable lifecycle producer using native follow, ledger and decision APIs."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid

BIN = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), BIN / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


follow, ledger, decisions, waker, receipts = (load(name) for name in
    ('agent-follow', 'mesh-ledger', 'agent-decisions', 'agent-waker', 'agent-run-receipt'))


def hash_value(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def flat(value, limit=320):
    return ' '.join(str(value or '').split())[:limit]


def stamp(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace('+00:00', 'Z')


def initial():
    return {'version': 1, 'seq': 0, 'ordinary': {}, 'seen': [], 'humanRefs': [], 'decisions': {},
            'nativeDecisions': {}, 'activeFaults': [], 'jobHashes': {}, 'ordinaryHashes': {}, 'lastSummaryAt': None, 'staged': None}


def private(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)


def save(path, value):
    private(path.parent)
    follow.atomic_json(path, value)
    os.chmod(path, 0o600)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_state(path):
    state = follow.read_json(path, initial())
    if not isinstance(state, dict) or state.get('version') != 1:
        raise ValueError('invalid beat state')
    return state


def excluded(ref, config):
    return config.get("selfRef") is not None and ref == config["selfRef"] or ref in config.get("excludeRefs", [])


def events_since(rows, state, config=None):
    """Return immediate facts, latest ordinary details, sequence and dedup hashes."""
    config = config or {}
    ordinary = {ref: value for ref, value in state['ordinary'].items() if not excluded(ref, config)}
    seen = set(state['seen'])
    ordinary_hashes = dict(state.get('ordinaryHashes', {}))
    immediate = []
    seq = state['seq']
    for row in rows:
        if row['seq'] <= state['seq']:
            continue
        seq = max(seq, row['seq'])
        kind, ref = row.get('kind'), row.get('ref')
        if excluded(ref, config):
            continue
        detail = flat(row.get('body'))
        completion, turn = row.get('completion'), row.get('turn_id')
        item = {'ref': ref, 'kind': kind, 'detail': detail}
        if completion:
            item['completion'] = completion
        if turn:
            item['turn_id'] = turn
        urgent = kind in ('ERROR', 'NOREPLY', 'STALLED') or kind == 'REPLY' and completion in ('task', 'thread') and bool(detail)
        if kind == 'LIFECYCLE':
            payload = row.get('payload') or {}
            status = payload.get('status')
            urgent = payload.get('phase') == 'failure' or status in ('blocked', 'failed')
            detail = 'lifecycle action failed' if urgent else flat(status)
            item = {'ref': ref, 'kind': kind, 'detail': detail}
            if payload.get('fingerprint'):
                item['observation'] = payload['fingerprint']
            if urgent and payload.get('reason'):
                item['reason'] = str(payload['reason'])
        if urgent:
            # Native duplicate completion markers for one turn are one fact.
            semantic = {key: value for key, value in item.items() if key != 'detail'} if turn else item
            key = hash_value(semantic)
            if key not in seen:
                seen.add(key)
                immediate.append(item)
        elif (kind == 'REPLY' or kind == 'LIFECYCLE') and detail:
            value = {'ref': ref, 'detail': detail}
            signature = hash_value(value)
            if ordinary_hashes.get(ref) != signature:
                ordinary[ref] = value
                ordinary_hashes[ref] = signature
    return immediate, ordinary, seq, sorted(seen)[-4096:], ordinary_hashes


def ledger_command(config):
    scheme = config.get('ledgerScheme')
    if not scheme:
        return None
    return ledger.adapters().get(scheme)


def fetch_changes(config, consumer, full=False):
    """Native adapter transaction, without advancing its canonical consumer yet."""
    adapter = ledger_command(config)
    if adapter is None:
        return [], None, [], False
    scheme = config['ledgerScheme']
    key = scheme + ':' + consumer
    with ledger.cursor_store() as (_, state):
        before = state['cursors'].get(key)
    cursor = None if full else before
    items, errors = {}, []
    limit = config.get('maxLedgerPages', 5)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError('invalid ledger page bound')
    for index in range(limit):
        request = {'cursor': cursor, 'limit': 200}
        if full and index == 0:
            request['full'] = True
        page = ledger.checked(ledger.invoke(adapter, 'changes', request), scheme, 'changes')
        if page['errors']:
            errors.append({'source': 'ledger', 'error': 'ledger page failed; cursor retained'})
            return list(items.values()), None, errors, True
        for item in page['items']:
            items[item['ref']] = item
        prior = cursor
        cursor = page['cursor']
        if not page['more']:
            break
        if cursor == prior:
            errors.append({'source': 'ledger', 'error': 'ledger page did not advance; cursor retained'})
            return list(items.values()), None, errors, True
    return list(items.values()), {'key': key, 'before': before, 'cursor': cursor}, errors, True


def commit_cursor(intent):
    """CAS only this native consumer, via its storage-owned API."""
    if intent is None:
        return True
    with ledger.cursor_store() as (path, state):
        current = state['cursors'].get(intent['key'])
        if current == intent['cursor']:
            return True
        if current != intent['before']:
            return False
        state['cursors'][intent['key']] = intent['cursor']
        ledger.save(path, state)
    return True


def describe_refs(config, refs):
    adapter = ledger_command(config)
    if adapter is None:
        return [], [], []
    items, missing, errors = [], [], []
    ordered = sorted(set(refs))
    for offset in range(0, len(ordered), 200):
        page_refs = ordered[offset:offset + 200]
        response = ledger.checked(ledger.invoke(adapter, 'describe', {'refs': page_refs}), config['ledgerScheme'], 'describe', page_refs)
        if response['errors']:
            errors.append({'source': 'ledger', 'error': 'ledger descriptions failed'})
            continue
        items.extend(response['items'])
        missing.extend(response['missing'])
    return items, missing, errors


def human(item):
    return item.get('status') in ('waiting', 'blocked') and (item.get('waitingOn') or {}).get('who') == 'human'


def card_for(item, config):
    if excluded(item.get('ref'), config):
        return None
    domain = item.get('domain')
    project = config.get('projectMap', {}).get(domain, domain)
    card = decisions.make_decision(item, project=project, where=config.get('whereByRef', {}).get(item['ref']),
        guard_sentence=config.get('guardSentence'), labels=config.get('labels'),
        question_template=config.get('questionTemplate', '{ask}'))
    if card is not None:
        wait = item.get('waitingOn') or {}
        card.update(urgency=wait.get('urgency', 'normal'), due=wait.get('due'))
        action = card['options'][0]['action']
        if action['kind'] == 'source-sentence':
            card['joseph_sentence'] = action['value']
    return card


def card_order(card):
    return ({'high': 0, 'normal': 1, 'low': 2}.get(card.get('urgency'), 1), card.get('due') or '9999', card['id'])


def decision_delta(config, state, epoch, full=False, consumer='lifecycle-beat', describe_all=False):
    items, intent, errors, enabled = fetch_changes(config, consumer, full)
    membership = {ref for ref in state['humanRefs'] if not excluded(ref, config)}
    for item in items:
        if human(item) and not excluded(item['ref'], config):
            membership.add(item['ref'])
        else:
            membership.discard(item['ref'])
    due = membership if describe_all else set(decisions.due_ids(state['decisions'], stamp(epoch)))
    due -= {item['ref'] for item in items}
    due = {ref for ref in due if not excluded(ref, config)}
    if enabled and due:
        described, missing, faults = describe_refs(config, due)
        items.extend(described)
        membership.difference_update(missing)
        errors.extend(faults)
    cards, closed = [], set(state['humanRefs']) - membership
    for item in items:
        if not human(item) or excluded(item['ref'], config):
            membership.discard(item['ref'])
            closed.add(item['ref'])
            continue
        try:
            card = card_for(item, config)
            if card:
                cards.append(card)
            else:
                errors.append({'source': 'decision', 'error': 'explicit human wait lacks usable question'})
        except (ValueError, KeyError, TypeError):
            errors.append({'source': 'decision', 'error': 'explicit human wait lacks usable source location'})
    emitted, candidate = decisions.select_due(cards, state['decisions'], stamp(epoch), config.get('timezone', 'UTC'),
        next_morning_hour=config.get('nextMorningHour', 9), interval_days=config.get('intervalDays', 2), closed_refs=closed)
    return (sorted(cards if describe_all else emitted, key=card_order), candidate, sorted(membership), intent, errors)


def native_decision_delta(config, state, epoch, follower_root, rows, tick_ok):
    """Use only formal follow QUESTION rows and official pending cursor facts.

    Caller owns the follow lock. No native inventory refresh occurs here.
    """
    previous = state.get('nativeDecisions', {})
    if not tick_ok:
        return [], previous, []
    questions = {row['ref']: row for row in rows if row['seq'] > state['seq'] and row.get('kind') == 'QUESTION' and not excluded(row.get('ref'), config)}
    refs = set(questions) | set(decisions.due_ids(previous, stamp(epoch)))
    closed = {ref for ref in previous if excluded(ref, config)}
    if not refs:
        return [], decisions.forget_closed(previous, closed), []
    active = []
    for ref in sorted(refs):
        if excluded(ref, config):
            closed.add(ref)
            continue
        cursor = follow.read_json(follow.cursor_path(follower_root, ref), {})
        pending = cursor.get('pending') or {}
        if pending.get('question_active') is not True:
            closed.add(ref)
            continue
        event = questions.get(ref)
        if event and pending.get('question_event_id') != event.get('event_id'):
            # Only the latest currently active formal question may be emitted.
            continue
        active.append((ref, pending))
    if not active:
        return [], decisions.forget_closed(previous, closed), []
    sources, rejected, _, _ = follow.session_source(config.get('followConfig', {}))
    cards, errors = [], []
    for ref, pending in active:
        if ref in rejected:
            closed.add(ref)
            continue
        source = sources.get(ref, {})
        harness, native = ref.split(':', 1)
        row = {'sessionId': ref, 'harness': harness, 'nativeId': native,
               'title': source.get('title') or 'Native tool question',
               'domains': source.get('domains') or [],
               'lastSeenAt': pending.get('question_timestamp') or stamp(epoch),
               'lifecycle': {'pendingQuestion': True, 'question': pending.get('question_body')}}
        current, gaps = native_questions({'sessions': [row]}, config)
        cards.extend(current)
        errors.extend(gaps)
    emitted, metadata = decisions.select_due(cards, previous, stamp(epoch), config.get('timezone', 'UTC'),
        next_morning_hour=config.get('nextMorningHour', 9), interval_days=config.get('intervalDays', 2), closed_refs=closed)
    return emitted, metadata, errors


def job_failures(config, state, epoch):
    events, hashes = [], {}
    for job in config.get('jobs', []):
        if excluded(job.get('name'), config):
            continue
        result = receipts.check_job(job, datetime.fromtimestamp(epoch, timezone.utc))
        key = str(result['job'])
        # Age/check/last-run timestamps do not create a new semantic failure.
        semantic = {field: result.get(field) for field in ('job', 'status', 'outcome', 'mismatch')}
        signature = hash_value(semantic)
        hashes[key] = signature
        if result['status'] not in ('ok', 'paused') and state['jobHashes'].get(key) != signature:
            events.append({'ref': key, 'kind': 'JOB', 'detail': 'native job health: ' + result['status']})
    return events, hashes


def acknowledged(staged, config):
    if not config.get('wakerState'):
        return False
    data = follow.read_json(Path(config['wakerState']).expanduser(), {})
    keys = (data.get('lastDelivery') or {}).get('itemKeys', [])
    return set(staged['keys']).issubset(keys)


def finish_ack(state, epoch):
    staged = state['staged']
    candidate = staged['candidate']
    for key in ('decisions', 'humanRefs', 'jobHashes', 'seen', 'nativeDecisions', 'activeFaults'):
        if key in candidate:
            state[key] = candidate[key]
    if staged['includesSummary']:
        state['ordinary'] = {}
        state['lastSummaryAt'] = epoch
    state['staged'] = None


def stage(root, state, config, epoch, immediate, cards, summary, candidate, intent, errors):
    reports = root / 'reports'
    private(reports)
    path = (reports / (str(int(epoch * 1000)) + '-' + uuid.uuid4().hex + '.json')).resolve()
    report = {'schema': 'agent-mesh.lifecycle-beat-report.v1', 'at': stamp(epoch), 'immediate': immediate,
              'decisions': cards, 'summary': summary, 'errors': errors,
              'humanWaitCount': len(candidate['humanRefs']) + len(candidate.get('nativeDecisions', {})), 'delivery': 'staged; execution unverified'}
    if cards and config.get('decisionDestination'):
        report['decisionDestination'] = config['decisionDestination']
    save(path, report)
    # Report location comes first: the waker's compact line may be truncated.
    items = [{'report': str(path), 'kind': 'lifecycle-beat', 'immediate': len(immediate),
              'decisions': len(cards), 'summary': len(summary), 'errors': len(errors)}]
    if cards and config.get('decisionDestination'):
        items[0]['decisionDestination'] = config['decisionDestination']
    state['staged'] = {'path': str(path), 'items': items, 'keys': [waker.item_key(item) for item in items],
                       'createdAt': epoch, 'includesSummary': bool(summary), 'candidate': candidate,
                       'ledgerCommit': intent}
    save(root / 'state.json', state)
    if commit_cursor(intent):
        state['staged']['ledgerCommit'] = None
    else:
        state['staged']['commitError'] = True
    save(root / 'state.json', state)
    return {'new': items, 'errors': [{'source': 'ledger', 'error': 'native ledger cursor conflict'}] if state['staged'].get('commitError') else []}


def producer(config, root, full=False, epoch=None):
    epoch = time.time() if epoch is None else epoch
    private(root)
    follower_root = Path(config['followerRoot']).expanduser() if config.get('followerRoot') else follow.state_dir(config.get('followerName', 'lifecycle'))
    private(follower_root)
    with follow.locked(root / 'producer.lock', nonblocking=True):
        state = read_state(root / 'state.json')
        # tick acquires its own lock; outbox repair is separately protected.
        tick_error = None
        try:
            follow.tick(follower_root, config.get('followConfig', {}), config.get('selfRef'))
        except (OSError, ValueError, RuntimeError):
            tick_error = {'source': 'follow', 'error': 'native follower tick failed'}
        if state['staged']:
            staged = state['staged']
            if staged.get('ledgerCommit') and commit_cursor(staged['ledgerCommit']):
                staged['ledgerCommit'] = None
                staged.pop('commitError', None)
                save(root / 'state.json', state)
            if staged.get('ledgerCommit') or not acknowledged(staged, config):
                return {'new': staged['items'], 'errors': [{'source': 'ledger', 'error': 'native ledger cursor conflict'}] if staged.get('commitError') else []}
            finish_ack(state, epoch)
            save(root / 'state.json', state)
        with follow.locked(follower_root / 'state.lock'):
            rows, _ = follow.outbox(follower_root)
            if tick_error:
                # Keep the uncertain QUESTION and all later sequence numbers for
                # the next successful observer tick, never discard a human ask.
                uncertain = next((row['seq'] for row in rows if row['seq'] > state['seq'] and row.get('kind') == 'QUESTION' and not excluded(row.get('ref'), config)), None)
                if uncertain is not None:
                    rows = [row for row in rows if row['seq'] < uncertain]
            native_cards, native_metadata, native_errors = native_decision_delta(config, state, epoch, follower_root, rows, tick_error is None)
        immediate, ordinary, seq, seen, ordinary_hashes = events_since(rows, state, config)
        errors = [tick_error] if tick_error else []
        cards, metadata, refs, intent, ledger_errors = decision_delta(config, state, epoch, full)
        errors.extend(ledger_errors)
        errors.extend(native_errors)
        cards = sorted([*cards, *native_cards], key=card_order)
        jobs, job_hashes = job_failures(config, state, epoch)
        immediate.extend(jobs)
        # Fixed source failures wake once per semantic condition, not timestamp.
        active_faults = sorted({hash_value(error) for error in errors})
        new_faults = set(active_faults) - set(state.get('activeFaults', []))
        for error in errors:
            key = hash_value(error)
            if key in new_faults:
                new_faults.discard(key)
                immediate.append({'ref': error['source'], 'kind': 'BEAT', 'detail': error['error']})
        state.update(seq=seq, ordinary=ordinary, ordinaryHashes=ordinary_hashes)
        summary_due = bool(ordinary) and (state['lastSummaryAt'] is None or epoch - state['lastSummaryAt'] >= config.get('summarySeconds', 1800))
        # The first ordinary observation starts its own summary window.
        if ordinary and state['lastSummaryAt'] is None:
            state['lastSummaryAt'] = epoch
            summary_due = False
        summary = [ordinary[ref] for ref in sorted(ordinary)] if summary_due else []
        candidate = {'decisions': metadata, 'humanRefs': refs, 'jobHashes': job_hashes, 'seen': seen[-4096:], 'nativeDecisions': native_metadata, 'activeFaults': active_faults}
        if immediate or cards or summary:
            return stage(root, state, config, epoch, immediate, cards, summary, candidate, intent, errors)
        state.update(candidate)
        save(root / 'state.json', state)
        if not commit_cursor(intent):
            # Even a quiet baseline keeps an exact conflicting intent pending;
            # acknowledging its failure report cannot discard unknown progress.
            fault = {'source': 'ledger', 'error': 'native ledger cursor conflict'}
            candidate['activeFaults'] = sorted(set(candidate['activeFaults']) | {hash_value(fault)})
            return stage(root, state, config, epoch, [{'ref': 'ledger', 'kind': 'BEAT', 'detail': fault['error']}],
                         [], [], candidate, intent, [fault])
        return {'new': [], 'errors': []}


def native_questions(inventory, config):
    cards, errors = [], []
    for row in inventory.get('sessions', []):
        life = row.get('lifecycle') or {}
        if life.get('pendingQuestion') is not True or not life.get('question'):
            continue
        ref, native = row.get('sessionId'), row.get('nativeId')
        if excluded(ref, config):
            continue
        where = config.get('whereByRef', {}).get(ref)
        if not where and row.get('harness') == 'codex' and isinstance(native, str) and follow.SESSION.fullmatch('codex:' + native):
            where = 'codex://threads/' + native
        if not where:
            template = config.get('nativeWhere', {}).get(row.get('harness'))
            if template:
                where = template.format(id=native, ref=ref)
        item = {'ref': ref, 'title': row.get('title') or 'Native tool question', 'status': 'waiting',
                'updatedAt': row.get('lastSeenAt'), 'waitingOn': {'who': 'human', 'ask': life['question']},
                'domain': next(iter(row.get('domains') or []), None), 'url': where}
        try:
            card = card_for(item, config)
            if card:
                cards.append(card)
        except (ValueError, KeyError, TypeError):
            errors.append({'source': 'native', 'ref': ref, 'error': 'native tool question lacks supported source location or facts'})
    return cards, errors


def interview(config, root, output, inventory=None, full=False, consumer='lifecycle-interview'):
    private(root)
    with follow.locked(root / 'producer.lock', nonblocking=True):
        state = read_state(root / 'state.json')
        cards, metadata, refs, intent, errors = decision_delta(config, state, time.time(), full, consumer, describe_all=True)
        if inventory:
            native_cards, native_errors = native_questions(inventory, config)
            cards.extend(native_cards)
            errors.extend(native_errors)
        report = {'schema': 'agent-mesh.lifecycle-interview.v1', 'decisions': sorted(cards, key=card_order), 'errors': errors}
        if cards and config.get('decisionDestination'):
            report['decisionDestination'] = config['decisionDestination']
        save(output, report)
        # Interview export is durable output, not a reminder delivery acknowledgement.
        state['humanRefs'] = refs
        save(root / 'state.json', state)
        if not commit_cursor(intent):
            raise RuntimeError('native interview cursor compare-and-swap failed')
    return {'output': str(output), 'decisions': len(cards), 'errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', choices=('producer', 'interview'), default='producer')
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state', type=Path)
    parser.add_argument('--full', action='store_true', help='explicit initial ledger snapshot')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--inventory', type=Path)
    parser.add_argument('--consumer', default='lifecycle-interview')
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        root = args.state or Path(config.get('stateRoot', follow.state_dir('lifecycle-beat' if args.mode == 'producer' else args.consumer)))
        if args.mode == 'interview':
            if args.state is None:
                root = root / ('interview-' + args.consumer)
            if not args.output:
                parser.error('interview requires --output')
            result = interview(config, root, args.output, json.loads(args.inventory.read_text()) if args.inventory else None, args.full, args.consumer)
        else:
            result = producer(config, root, args.full)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, ledger.ProtocolError):
        print(json.dumps({'new': [], 'errors': [{'source': 'lifecycle-beat', 'error': 'lifecycle beat source or state failure'}]}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
