#!/usr/bin/env python3
"""Generic per-thread archive hook protocol; no private guard or native parser.

The engine injects its small API facade. Host hooks own canonical eligibility,
durable summaries, independent AI review and the native archive operation.
"""
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import stat

SESSION = re.compile(r'(?:codex|claude):[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
SHA = re.compile(r'[0-9a-f]{64}')
CODE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}')


def artifact(value, api):
    if not isinstance(value, dict) or not isinstance(value.get('path'), str) or not SHA.fullmatch(str(value.get('sha256', ''))):
        raise api.Error('archive artifact descriptor invalid')
    path = Path(value['path'])
    if not path.is_absolute():
        raise api.Error('archive artifact path must be absolute')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if before.st_size > 16 * 1024 * 1024:
                raise api.Error('archive artifact exceeds size bound')
            if not stat.S_ISREG(before.st_mode):
                raise api.Error('archive artifact is not a regular file')
            result = hashlib.sha256()
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                result.update(chunk)
            after = os.fstat(stream.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns) or result.hexdigest() != value['sha256']:
            raise api.Error('archive artifact digest changed')
    except OSError:
        raise api.Error('archive artifact unavailable') from None
    return {'path': str(path), 'sha256': value['sha256']}


def invoke(config, name, request, api):
    try:
        timeout = config.get(name.replace('Command', 'TimeoutMs'), 240000 if name == 'archiveReviewCommand' else 120000)
        code, data = api.run(config[name], request, timeout_ms=timeout)
    except (api.Error, OSError, ValueError):
        raise api.Error('archive ' + name + ' transport failed') from None
    if code or not isinstance(data, dict):
        raise api.Error('archive ' + name + ' returned invalid protocol')
    return data


def reason(data, api):
    value = data.get('reasonCode')
    if not isinstance(value, str) or not CODE.fullmatch(value):
        raise api.Error('archive semantic reason code invalid')
    return value


def prepare(plan, inventory, config, run_dir, api, history_records=()):
    """Stage a bounded frozen pool; semantic refusals do not stop preparation."""
    enabled = config.get('maxArchives', 0) > 0 and all(config.get(name) for name in ('archivePrepareCommand', 'archiveReviewCommand', 'archiveApplyCommand'))
    batch = {'status': 'ready' if enabled else 'report-only', 'successLimit': config.get('maxArchives', 0),
             'prepareLimit': config.get('archiveMaxCandidates', config.get('archivePrepareLimit', 100)), 'prepareCalls': 0, 'prepared': [], 'skipped': []}
    plan['archive'] = batch
    reviewed_refs = {entry['session'] for entry in config.get('reviewedTemporaryRefs', [])}
    plan['actions'] = [action for action in plan['actions'] if action['session'] not in reviewed_refs]
    if not enabled:
        plan['digest'] = api.digest({key: value for key, value in plan.items() if key != 'digest'})
        return plan
    if inventory.get('complete') is not True:
        batch.update(status='technical-error', reason='native inventory incomplete; archive preparation stopped')
        plan['digest'] = api.digest({key: value for key, value in plan.items() if key != 'digest'})
        return plan
    previous = history(history_records)
    rows = {row['sessionId']: row for row in inventory['sessions']}
    entries = {entry['session']: entry for entry in plan['entries']}
    # Finished temporary Codex work remains a potential candidate even when its
    # ordinary resume classification is keep-noise/ephemeral. Eligibility stays
    # exclusively with the hard guard and canonical host adapter.
    completed = [row['sessionId'] for row in inventory['sessions'] if row.get('harness') == 'codex'
                 and (row.get('lifecycle') or {}).get('completion') == 'task'
                 and (row.get('lifecycle') or {}).get('turnActive') is False
                 and (row.get('lifecycle') or {}).get('historyComplete') is True]
    ordered = list(dict.fromkeys([entry['session'] for entry in config.get('reviewedTemporaryRefs', [])] +
                                [entry['session'] for entry in plan['entries'] if entry['classification'] == 'archive-candidate'] + completed))
    # Derive fair rotation from the existing receipt stream, never another
    # cursor authority. Unconsidered refs precede previously considered refs.
    considered = {record.get('session'): index for index, record in enumerate(history_records)
                  if record.get('kind') == 'archive' and record.get('phase') == 'archive-considered'}
    ordered.sort(key=lambda session: considered.get(session, -1))
    for session in ordered:
        if len(batch['prepared']) >= batch['successLimit'] or batch['prepareCalls'] >= batch['prepareLimit']:
            break
        row = rows.get(session)
        fingerprint = api.fingerprint(row) if row else None
        base = {'at': api.now(), 'consumer': plan['consumer'], 'kind': 'archive', 'session': session,
                'fingerprint': fingerprint, 'stage': 'prepare'}
        api.append(run_dir / 'actions.jsonl', {**base, 'phase': 'archive-considered'})
        refusal = api.archive_guard(row, inventory, config)
        prior = previous.get(session, {})
        if not refusal and prior.get('successes') and fingerprint in prior.get('fingerprints', set()):
            refusal = 'previous_native_archive_confirmed'
        if refusal:
            batch['skipped'].append({'session': session, 'reasonCode': refusal})
            api.append(run_dir / 'actions.jsonl', {**base, 'phase': 'preparation-skipped', 'status': 'skipped', 'reasonCode': refusal})
            continue
        batch['prepareCalls'] += 1
        try:
            data = invoke(config, 'archivePrepareCommand', {'session': session, 'fingerprint': fingerprint, 'runDir': str(run_dir.resolve())}, api)
            if data.get('status') == 'skipped':
                code = reason(data, api)
                batch['skipped'].append({'session': session, 'reasonCode': code})
                api.append(run_dir / 'actions.jsonl', {**base, 'phase': 'preparation-skipped', 'status': 'skipped', 'reasonCode': code})
                continue
            if data.get('status') != 'eligible' or data.get('session') != session or data.get('fingerprint') != fingerprint:
                raise api.Error('archive preparation failed or identity mismatch')
            if data.get('obligationsChecked') is not True:
                raise api.Error('canonical per-thread obligation attestation required')
            action = {'kind': 'archive', 'session': session, 'fingerprint': fingerprint, 'obligationsChecked': True,
                      'summary': artifact(data.get('summary'), api), 'evidence': artifact(data.get('evidence'), api)}
            action['actionDigest'] = api.digest(action)
            batch['prepared'].append(action)
            entry = entries[session]
            entry['originalClassification'] = entry['classification']
            entry.update(classification='archive-prepared', reason='prepared by canonical adapter; independent action review pending')
        except api.Error as error:
            batch.update(status='technical-error', reason=str(error), failedSession=session)
            break
    # A source thread can never be resumed and archived in the same frozen plan.
    archive_refs = {action['session'] for action in batch['prepared']}
    plan['actions'] = [action for action in plan['actions'] if action['session'] not in archive_refs] + batch['prepared']
    plan['counts'] = dict(Counter(entry['classification'] for entry in plan['entries']))
    plan['approvals'] = [entry for entry in plan['entries'] if entry['classification'].startswith('approval-') or entry['classification'] in ('archive-candidate', 'archive-prepared', 'handoff-candidate')]
    plan['digest'] = api.digest({key: value for key, value in plan.items() if key != 'digest'})
    return plan


def review(plan, config, run_dir, api):
    if any(action.get('obligationsChecked') is not True for action in plan['actions'] if action.get('kind') == 'archive'):
        raise api.Error('archive review requires canonical per-thread obligation attestation')
    actor = config.get('selfRef')
    if not isinstance(actor, str) or not SESSION.fullmatch(actor):
        raise api.Error('archive actor identity required for independent review')
    plan_path = run_dir / 'plan.json'
    try:
        persisted = json.loads(plan_path.read_text())
    except (OSError, ValueError):
        raise api.Error('archive review requires persisted frozen plan') from None
    if persisted != plan or api.digest({key: value for key, value in persisted.items() if key != 'digest'}) != plan['digest']:
        raise api.Error('archive review plan digest mismatch')
    stored = run_dir / 'archive-review.json'
    if stored.exists():
        try:
            response = json.loads(stored.read_text())
        except (OSError, ValueError):
            raise api.Error('persisted archive review invalid') from None
    else:
        response = invoke(config, 'archiveReviewCommand', {'planPath': str(plan_path.resolve()), 'planDigest': plan['digest'], 'actor': actor}, api)
    if not isinstance(response, dict):
        raise api.Error('archive review response must be an object')
    descriptor = artifact(response.get('receipt'), api)
    try:
        if Path(descriptor['path']).stat().st_size > 1024 * 1024:
            raise ValueError()
        receipt = json.loads(Path(descriptor['path']).read_text())
    except (OSError, ValueError):
        raise api.Error('archive review receipt invalid') from None
    artifact(descriptor, api)
    if not isinstance(receipt, dict):
        raise api.Error('archive review receipt must be an object')
    if any(receipt.get(key) != response.get(key) for key in ('verdict', 'planDigest', 'reviewerRef', 'decisions')):
        raise api.Error('archive review response and receipt mismatch')
    reviewer = receipt.get('reviewerRef')
    if receipt.get('verdict') not in ('PASS', 'FAIL') or receipt.get('planDigest') != plan['digest'] or not isinstance(reviewer, str) or not SESSION.fullmatch(reviewer) or reviewer == actor:
        raise api.Error('independent archive review identity or verdict invalid')
    identity = api.query(config, 'resume', {'session': reviewer})
    if identity.get('sessionId') != reviewer or identity.get('nativeId') != reviewer.split(':', 1)[1] or identity.get('harness') != reviewer.split(':', 1)[0]:
        raise api.Error('archive reviewer native identity unverified')
    expected = {action['actionDigest'] for action in plan['actions'] if action['kind'] == 'archive'}
    decisions = receipt.get('decisions')
    if not isinstance(decisions, list) or len(decisions) != len(expected):
        raise api.Error('archive review action decisions incomplete')
    mapped = {}
    for decision in decisions:
        if not isinstance(decision, dict) or decision.get('actionDigest') not in expected or decision['actionDigest'] in mapped or decision.get('verdict') not in ('PASS', 'SKIP'):
            raise api.Error('archive review action decision invalid')
        if decision['verdict'] == 'SKIP':
            reason(decision, api)
        mapped[decision['actionDigest']] = decision
    if receipt['verdict'] == 'FAIL' and any(value['verdict'] != 'SKIP' for value in mapped.values()):
        raise api.Error('overall archive refusal contains an executable action')
    if not stored.exists():
        api.write(stored, {'receipt': descriptor, **receipt})
    return {'receipt': descriptor, 'reviewerRef': reviewer, 'decisions': mapped}


def apply_action(action, plan, inventory, config, run_dir, reviewed, base, api):
    """Fresh guard and hashes immediately before the private canonical adapter."""
    if inventory.get('complete') is not True:
        raise api.Error('fresh native inventory incomplete; archive stopped')
    if action.get('obligationsChecked') is not True:
        raise api.Error('canonical per-thread obligation attestation required')
    refusal = api.archive_guard(next((row for row in inventory['sessions'] if row['sessionId'] == action['session']), None), inventory, config)
    if refusal:
        return {'status': 'skipped', 'reasonCode': refusal}
    row = next(row for row in inventory['sessions'] if row['sessionId'] == action['session'])
    if api.fingerprint(row) != action['fingerprint']:
        return {'status': 'skipped', 'reasonCode': 'native_observation_changed'}
    if action['actionDigest'] != api.digest({key: value for key, value in action.items() if key != 'actionDigest'}):
        raise api.Error('archive action digest mismatch')
    summary, evidence = artifact(action['summary'], api), artifact(action['evidence'], api)
    artifact(reviewed['receipt'], api)
    api.append(run_dir / 'actions.jsonl', {**base, 'at': api.now(), 'phase': 'archive-attempt', 'actionDigest': action['actionDigest']})
    result = invoke(config, 'archiveApplyCommand', {'session': action['session'], 'planDigest': plan['digest'],
        'actionDigest': action['actionDigest'], 'summary': summary, 'evidence': evidence, 'reviewReceipt': reviewed['receipt']}, api)
    if result.get('status') == 'skipped':
        return {'status': 'skipped', 'reasonCode': reason(result, api)}
    if result.get('status') != 'archived' or any(result.get(key) != value for key, value in
        (('session', action['session']), ('planDigest', plan['digest']), ('actionDigest', action['actionDigest']))):
        raise api.Error('archive apply failed or outcome ambiguous')
    descriptor = artifact(result.get('receipt'), api)
    try:
        if Path(descriptor['path']).stat().st_size > 1024 * 1024:
            raise ValueError()
        receipt = json.loads(Path(descriptor['path']).read_text())
    except (OSError, ValueError):
        raise api.Error('native archive confirmation receipt invalid') from None
    artifact(descriptor, api)
    if not isinstance(receipt, dict):
        raise api.Error('native archive confirmation must be an object')
    if receipt.get('nativeArchived') is not True or any(receipt.get(key) != value for key, value in
        (('status', 'archived'), ('session', action['session']), ('planDigest', plan['digest']), ('actionDigest', action['actionDigest']))):
        raise api.Error('native archive confirmation unverified')
    return {'status': 'archived', 'receipt': descriptor}


def history(records):
    """Primary archive uncertainty stays in the existing action receipt stream."""
    states = {}
    for record in records:
        if record.get('kind') != 'archive':
            continue
        state = states.setdefault(record.get('session'), {'unresolved': False, 'successes': set(), 'fingerprints': set(), 'skipped': set(), 'attempts': set()})
        phase = record.get('phase')
        if phase == 'archive-attempt':
            state['attempts'].add((record.get('planDigest'), record.get('actionDigest')))
            state['fingerprints'].add(record['fingerprint'])
        elif phase == 'acknowledgement' and record.get('status') == 'archived':
            state['attempts'].discard((record.get('planDigest'), record.get('actionDigest')))
            state['successes'].add((record.get('planDigest'), record.get('actionDigest')))
        elif phase == 'skipped' and record.get('actionDigest'):
            state['attempts'].discard((record.get('planDigest'), record.get('actionDigest')))
            state['skipped'].add((record.get('planDigest'), record.get('actionDigest')))
        state['unresolved'] = bool(state['attempts'])
    return states
