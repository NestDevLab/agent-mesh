#!/usr/bin/env python3
"""Conservative native lifecycle inventory, planning and acknowledged queueing.

Mesh owns discovery and identity. This module never parses transcripts or native
storage, and never equates queue acknowledgement with completed work.
"""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid
import unicodedata
from types import SimpleNamespace

BIN = Path(__file__).resolve().parent
UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
SAFETY = ('This message grants no new permissions. Stop for a human decision, production action, external side effect, '
          'irreversible action, or changed scope. Report the verified outcome and any remaining gate.')
PROMPT = ('Continue only the original requested work using your own prior context and linked authoritative sources. ' + SAFETY)


class LifecycleError(RuntimeError):
    pass


class RetryableFailure(LifecycleError):
    def __init__(self, reason, retry_class):
        super().__init__(reason)
        self.retry_class = retry_class



def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def instant(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timezone required')
    return result


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def validate_config(config):
    if not isinstance(config, dict):
        raise LifecycleError('configuration must be an object')
    for field, default, maximum in [('maxResumes', 0, 3), ('maxArchives', 0, 10), ('archivePrepareLimit', 100, 200), ('archiveMaxCandidates', 100, 200), ('archiveReviewTimeoutMs', 240000, 300000), ('archivePrepareTimeoutMs', 120000, 120000), ('archiveApplyTimeoutMs', 120000, 120000), ('idleSeconds', 3600, 31536000), ('retryBaseSeconds', 300, 86400), ('retryMaxSeconds', 3600, 604800), ('retryMaxAttempts', 3, 10)]:
        value = config.get(field, default)
        if type(value) is not int or not 0 <= value <= maximum:
            raise LifecycleError('invalid ' + field)
    if config.get('retryBaseSeconds', 300) < 1 or config.get('retryMaxSeconds', 3600) < config.get('retryBaseSeconds', 300):
        raise LifecycleError('retry delays require positive base and maximum >= base')
    for field in ('permanentRefs', 'permanentPrefixes', 'permanentPatterns', 'excludeRefs', 'excludePatterns',
                  'allowedProjects', 'archiveProjects', 'continuationPatterns', 'humanWaitPatterns'):
        if not isinstance(config.get(field, []), list) or any(not isinstance(value, str) for value in config.get(field, [])):
            raise LifecycleError('invalid ' + field)
        if field.endswith('Patterns'):
            for pattern in config.get(field, []):
                re.compile(pattern)
    for entry in config.get('projectRoots', []):
        if not isinstance(entry, dict) or not isinstance(entry.get('project'), str) or not isinstance(entry.get('root'), str) or not Path(entry['root']).expanduser().is_absolute():
            raise LifecycleError('invalid project root')
    for field in ('archivePrepareLimit', 'archiveMaxCandidates', 'archiveReviewTimeoutMs', 'archivePrepareTimeoutMs', 'archiveApplyTimeoutMs'):
        if config.get(field, 1) < 1:
            raise LifecycleError('invalid ' + field)
    if 'archivePrepareLimit' in config and 'archiveMaxCandidates' in config and config['archivePrepareLimit'] != config['archiveMaxCandidates']:
        raise LifecycleError('archive candidate limit aliases disagree')
    approvals = config.get('reviewedTemporaryRefs', [])
    if not isinstance(approvals, list) or any(not isinstance(entry, dict) or not isinstance(entry.get('session'), str) or not re.fullmatch(r'(?:codex|claude):' + UUID.pattern, entry['session']) or not re.fullmatch(r'[0-9a-f]{64}', str(entry.get('fingerprint', ''))) for entry in approvals):
        raise LifecycleError('reviewed temporary refs require native session and observation fingerprint')
    consumer = config.get('consumer', 'lifecycle')
    if not isinstance(consumer, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', consumer):
        raise LifecycleError('invalid consumer')
    for key, value in config.items():
        if key.endswith('Command') and (not isinstance(value, list) or not value or any(not isinstance(arg, str) or not arg for arg in value)):
            raise LifecycleError('commands must be nonempty argv arrays')
    if config.get('eventOutbox') is not None and (not isinstance(config['eventOutbox'], str) or not Path(config['eventOutbox']).expanduser().is_absolute()):
        raise LifecycleError('eventOutbox must be an absolute native follower root')
    return config


def command(config, key, default):
    return config.get(key, default)


HELPER_OUTPUT_BYTES = 16 * 1024 * 1024
_transport = None


def run(argv, payload=None, *, raw=False, timeout_ms=120000):
    """Reuse Mesh's bounded native transport, never accumulating stderr."""
    global _transport
    if _transport is None:
        spec = importlib.util.spec_from_file_location('lifecycle_native_transport', BIN / 'mesh-ledger.py')
        _transport = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_transport)
    try:
        code, output = _transport.run_process(argv, payload, timeout_ms=timeout_ms,
                                              max_output=HELPER_OUTPUT_BYTES, label='native helper')
    except _transport.ProtocolError as error:
        raise LifecycleError(str(error)) from None
    text = output.decode('utf-8', 'replace').strip()
    if raw:
        return code, text
    try:
        data = json.loads(text) if text else None
    except ValueError:
        data = None
    return code, data


def sanitize(value, limit=None):
    # Flatten controls, format characters and Unicode line/paragraph separators.
    text = ''.join(' ' if unicodedata.category(char).startswith('C') or char.isspace() else char for char in value)
    return ' '.join(text.split())[:limit]


def work_item(config, session):
    """The host adapter attests that this session owns an open work item."""
    try:
        code, output = run(config['workItemCommand'], {'session': session}, raw=True, timeout_ms=10000)
    except LifecycleError as error:
        return None, 'work item lookup failed: ' + str(error)
    if code:
        return None, 'work item command exited with error'
    if not output:
        return None, 'work item command returned no item'
    try:
        item = json.loads(output)
    except ValueError:
        return None, 'work item command returned invalid JSON'
    if item is None or item == {} or item == []:
        return None, 'work item command returned no item'
    if (not isinstance(item, dict) or type(item.get('item')) not in (str, int)
            or not isinstance(item.get('title'), str) or not isinstance(item.get('nextStep'), str)):
        return None, 'work item command returned invalid item fields'
    clean = {'item': sanitize(str(item['item'])), 'title': sanitize(item['title'], 120),
             'nextStep': sanitize(item['nextStep'], 200)}
    if not all(clean.values()):
        return None, 'work item command returned empty item fields'
    return clean, None


def resume_prompt(action):
    item = action.get('workItem')
    if item is None:
        return PROMPT
    return (f"Continue work item {item['item']}: {item['title']}. "
            f"Next step: {item['nextStep']}. " + SAFETY)


def mesh(config, operation, payload=None, full=False):
    argv = [*command(config, 'meshCommand', ['node', str(BIN / 'mesh-graph.mjs')]), operation]
    if operation == 'query':
        raise LifecycleError('query name required')
    if full:
        argv.append('--full')
    code, data = run([*argv, '--json'], payload)
    if code or not isinstance(data, dict):
        raise LifecycleError('Mesh source failed')
    return data


def query(config, name, payload):
    code, data = run([*command(config, 'meshCommand', ['node', str(BIN / 'mesh-graph.mjs')]),
                      'query', name, '--input', json.dumps(payload), '--json'])
    if code or not isinstance(data, dict) or data.get('errors'):
        raise LifecycleError('Mesh query failed')
    return data


def collect(config, full=False):
    sessions, errors, coverage = {}, [], True
    try:
        sweep = mesh(config, 'sweep', full=full)
        if sweep.get('errors'):
            errors.append('Mesh sweep reported source errors')
    except LifecycleError as error:
        errors.append(str(error))
    cursor, visited = None, set()
    while True:
        try:
            page = query(config, 'search', {'limit': 200, **({'cursor': cursor} if cursor else {})})
            rows = page.get('sessions')
            if not isinstance(rows, list) or len(rows) > 200 or page.get('errors'):
                raise LifecycleError('invalid Mesh inventory page')
            coverage = coverage and page.get('linkCoverage') is True
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get('sessionId'), str) or row['sessionId'] in sessions:
                    raise LifecycleError('invalid or repeated native identity')
                sessions[row['sessionId']] = row
            cursor = page.get('cursor')
            if cursor is None:
                break
            if not isinstance(cursor, str) or not cursor or cursor in visited:
                raise LifecycleError('invalid Mesh inventory cursor')
            visited.add(cursor)
        except LifecycleError as error:
            errors.append(str(error))
            break
    return {'schema': 'agent-mesh.lifecycle-inventory.v1', 'at': now(), 'sessions': list(sessions.values()),
            'linkCoverage': coverage, 'complete': not errors, 'errors': errors}


def project_for(row, config):
    cwd = row.get('cwd')
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    choices = []
    for entry in config.get('projectRoots', []):
        root = Path(entry['root']).expanduser().resolve()
        if Path(cwd).resolve().is_relative_to(root):
            choices.append((len(root.parts), entry['project']))
    return max(choices)[1] if choices else None


def matching(patterns, text):
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def fingerprint(row):
    # Discovery timestamps can advance without a new native observation.
    life = row.get('lifecycle') or {}
    return digest({'session': row['sessionId'], 'cwd': row.get('cwd'), 'status': row.get('status'),
                   'attention': row.get('attention'), 'lifecycle': {key: life.get(key) for key in
                   ('turnId', 'turnActive', 'outcome', 'completion', 'completedAt', 'lastSpeaker',
                    'lastEventKind', 'lastEventId', 'lastHumanAt', 'question', 'pendingQuestion', 'error', 'detail')}})


def model_capacity(error):
    """Only explicit provider facts, never arbitrary stderr/keyword heuristics."""
    code = error.get('code') if isinstance(error, dict) else None
    message = error.get('message', '') if isinstance(error, dict) else error
    message = ' '.join(str(message or '').split()).casefold()
    return code in {'model_capacity', 'selected_model_at_capacity', 'model_overloaded'} or message.rstrip('.') == 'selected model is at capacity' or message.startswith('selected model is at capacity.')


def retry_delay(config, count):
    return min(config.get('retryMaxSeconds', 3600), config.get('retryBaseSeconds', 300) * 2 ** min(count, 10))


def classify(row, config, at):
    ref, life = row['sessionId'], row.get('lifecycle') or {}
    project = project_for(row, config)
    result = {'session': ref, 'project': project, 'classification': 'keep', 'reason': 'no continuation evidence',
              'fingerprint': fingerprint(row), 'sourceGaps': []}
    text = '\n'.join(str(value or '') for value in (row.get('title'), ref, row.get('cwd'), life.get('detail'), life.get('question')))
    linked = [link.get('ref', '') for link in row.get('links', []) if isinstance(link, dict)]
    refs = [ref, *linked]
    def finish(kind, reason):
        result.update(classification=kind, reason=reason)
        return result
    if row.get('archived') is True:
        return finish('keep-archived', 'native archived identity')
    attention = row.get('attention') or {}
    attention_state = attention.get('state', '') if isinstance(attention, dict) else str(attention)
    if row.get('origin') in ('subagent', 'automation') or row.get('class') == 'ephemeral' or 'noise' in str(row.get('reasons', [])).lower() or attention_state == 'noise':
        return finish('keep-noise', 'subagent or explicit noise classification')
    if ref == config.get('selfRef') or row.get('class') == 'orchestrator' or any(value in config.get('permanentRefs', []) or any(value.startswith(prefix) for prefix in config.get('permanentPrefixes', [])) for value in refs) or matching([r'\b(?:director|coordinator)\b', *config.get('permanentPatterns', [])], text):
        return finish('approval-compaction', 'permanent or coordinator session protected')
    if any(value in config.get('excludeRefs', []) for value in refs) or matching(config.get('excludePatterns', []), text):
        return finish('approval-excluded', 'policy exclusion remains visible')
    if project is None or project not in config.get('allowedProjects', []):
        return finish('approval-project', 'project is outside operative policy')
    if model_capacity(life.get('error')):
        try:
            failed_at = instant(life.get('completedAt') or row['lastSeenAt'])
            result['retryability'] = {'retryable': True, 'retryClass': 'model-capacity', 'failureAt': failed_at.isoformat(),
                                     'nextRetryAt': (failed_at + timedelta(seconds=retry_delay(config, 0))).isoformat()}
        except (ValueError, TypeError, KeyError):
            result['sourceGaps'].append('model capacity failure timestamp unavailable')
            return finish('keep-source-gap', 'capacity retry lacks native timestamp')
    if life.get('pendingQuestion') or matching(config.get('humanWaitPatterns', []), text):
        return finish('approval-human', 'pending human question or explicit human wait')
    if not isinstance(row.get('nativeId'), str) or not UUID.fullmatch(row['nativeId']):
        result['sourceGaps'].append('full native identity unavailable')
        return finish('keep-source-gap', 'native identity unavailable')
    try:
        idle = (instant(at) - instant(row['lastSeenAt'])).total_seconds()
    except (KeyError, TypeError, ValueError):
        result['sourceGaps'].append('last activity timestamp unavailable')
        return finish('keep-source-gap', 'cannot establish inactivity')
    if idle < config.get('idleSeconds', 3600):
        return finish('keep-recent', 'native activity is recent')
    path, cwd = life.get('path'), row.get('cwd')
    if not isinstance(path, str) or not Path(path).is_absolute() or not Path(path).is_file() or not isinstance(cwd, str) or not Path(cwd).is_dir() or life.get('metadataOnly') is True:
        result['sourceGaps'].append('local cwd or native history unavailable')
        return finish('keep-source-gap', 'local work sources unavailable')
    if 'pendingQuestion' not in life:
        result['sourceGaps'].append('pending human question fact unavailable')
        return finish('keep-source-gap', 'cannot exclude a human decision')
    stalled = attention_state.startswith('stalled') or (life.get('turnActive') is True and row.get('status') in ('quiet', 'blocked')) or life.get('outcome') in ('error', 'interrupted')
    complete = life.get('completion') == 'task' and life.get('turnActive') is False
    continuing = complete and matching(config.get('continuationPatterns', []), text)
    if stalled or continuing:
        if result.get('retryability') and instant(at) < instant(result['retryability']['nextRetryAt']):
            return finish('keep-retry-backoff', 'native model capacity rejection waiting for backoff')
        if row.get('harness') == 'claude':
            return finish('handoff-candidate', 'Codex child handoff uses governed launcher and new-target ownership proof')
        if row.get('harness') != 'codex':
            return finish('keep-source-gap', 'operative runtime unsupported')
        if row.get('resumable') is False and set(row.get('resumabilityReasons', row.get('reasons', []))) - {'occupied', 'desktop-owned'}:
            return finish('keep-source-gap', 'Mesh reports a native resume blocker')
        if 'workItemCommand' in config:
            item, reason = work_item(config, ref)
            if item is None:
                return finish('keep-no-work-item', reason)
            result['workItem'] = item
        return finish('resume-candidate', 'stalled native work' if stalled else 'explicit continuation policy')
    if complete and project in config.get('archiveProjects', []):
        if life.get('historyComplete') is not True:
            result['sourceGaps'].append('complete native history not proven')
        result['sourceGaps'].append('supported archive adapter, durable summary and independent digest-bound PASS required')
        return finish('archive-candidate', 'archive requires separate reviewed adapter')
    return result


def archive_guard(row, inventory, config):
    """Hard protections apply even to observation-bound temporary approvals."""
    if not inventory.get('complete') or inventory.get('linkCoverage') is not True:
        return 'source_coverage_unproven'
    if row is None:
        return 'native_session_missing'
    ref, life = row['sessionId'], row.get('lifecycle') or {}
    refs = [ref, *[link.get('ref', '') for link in row.get('links', []) if isinstance(link, dict)]]
    hard_text = '\n'.join(str(value or '') for value in (ref, row.get('cwd'), life.get('question')))
    text = hard_text + '\n' + str(row.get('title') or '') + '\n' + str(life.get('detail') or '')
    if ref == config.get('selfRef') or row.get('class') == 'orchestrator' or str(row.get('role', '')).casefold() in ('director', 'coordinator', 'orchestrator'):
        return 'hard_role_protection'
    if any(value in config.get('permanentRefs', []) or any(value.startswith(prefix) for prefix in config.get('permanentPrefixes', [])) for value in refs):
        return 'permanent_catalog_protection'
    if any(value in config.get('excludeRefs', []) for value in refs) or matching(config.get('excludePatterns', []), text):
        return 'policy_excluded'
    if row.get('harness') != 'codex':
        return 'unsupported_harness'
    if life.get('pendingQuestion') is not False or matching(config.get('humanWaitPatterns', []), text):
        return 'human_wait_or_unknown'
    reviewed = any(entry['session'] == ref and entry['fingerprint'] == fingerprint(row) for entry in config.get('reviewedTemporaryRefs', []))
    patterns = [r'\b(?:director|coordinator)\b', *config.get('permanentPatterns', [])]
    if matching(patterns, hard_text) or not reviewed and matching(patterns, text):
        return 'permanent_policy_protection'
    if not reviewed and project_for(row, config) not in config.get('archiveProjects', []):
        return 'archive_project_out_of_scope'
    native = row.get('nativeId')
    if not isinstance(native, str) or not UUID.fullmatch(native) or ref != 'codex:' + native:
        return 'native_identity_unproven'
    if row.get('archived') is True:
        return 'already_archived'
    if life.get('turnActive') is not False:
        return 'active_or_unknown_turn'
    path, cwd = life.get('path'), row.get('cwd')
    if life.get('historyComplete') is not True or life.get('metadataOnly') is True or not isinstance(path, str) or not Path(path).is_absolute() or not Path(path).is_file() or not isinstance(cwd, str) or not Path(cwd).is_dir():
        return 'local_history_unproven'
    try:
        if (instant(now()) - instant(row['lastSeenAt'])).total_seconds() < config.get('idleSeconds', 3600):
            return 'native_activity_recent'
    except (ValueError, TypeError, KeyError):
        return 'native_activity_unknown'
    return None


_archive = None


def archive_module():
    global _archive
    if _archive is None:
        spec = importlib.util.spec_from_file_location('lifecycle_archive', BIN / 'agent-lifecycle-archive.py')
        _archive = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_archive)
    return _archive


def archive_api():
    return SimpleNamespace(Error=LifecycleError, run=run, digest=digest, write=write, append=append,
                           query=query, fingerprint=fingerprint, archive_guard=archive_guard, now=now)


def build_plan(inventory, config, attempted_fingerprints=(), retry_records=()):
    entries = [classify(row, config, inventory['at']) for row in inventory['sessions']]
    seen = set(attempted_fingerprints)
    states = retry_states(retry_records, config)
    for entry in entries:
        context = child_context(states, entry['session'])
        if context and context.get('fingerprint') != entry['fingerprint'] and entry['classification'] == 'handoff-candidate':
            entry.update(classification='keep-child-held', reason='recorded child requires reconciliation before a different observation')
        retry = states.get(entry['fingerprint'])
        if retry and (retry.get('failure') or {}).get('retryable'):
            entry['retry'] = retry['failure']

        if entry.get('retryability') and entry['classification'] in ('resume-candidate', 'handoff-candidate', 'keep-retry-backoff'):
            scope = digest({'session': entry['session'], 'item': (entry.get('workItem') or {}).get('item')})
            count = sum(record.get('phase') == 'attempt' and record.get('modelCapacityScope') == scope for record in retry_records)
            entry['modelCapacityScope'] = scope
            due = instant(entry['retryability']['failureAt']) + timedelta(seconds=retry_delay(config, count))
            entry['retryability'].update(retryAttempt=count, nextRetryAt=due.isoformat(), retryExhausted=count >= config.get('retryMaxAttempts', 3))
            if count >= config.get('retryMaxAttempts', 3):
                entry.update(classification='keep-retry-held', reason='model capacity retry hard cap reached; reconciliation required')
            elif instant(inventory['at']) < due:
                entry.update(classification='keep-retry-backoff', reason='native model capacity rejection waiting for backoff')
        if entry['fingerprint'] in seen and entry['classification'] in ('resume-candidate', 'handoff-candidate'):
            retrying = bool(retry and (retry.get('failure') or {}).get('retryable'))
            entry.update(classification='keep-retry-held' if retrying and (retry['failure'].get('retryExhausted')) else 'keep-retry-backoff' if retrying else 'keep-attempted',
                         reason='retry is bounded by receipt backoff or hard cap' if retrying else 'native attempt recorded; await a new observation')
    counts = dict(Counter(entry['classification'] for entry in entries))
    projects = dict(Counter(entry['project'] or 'unmapped' for entry in entries))
    selected = []
    if inventory['complete']:
        selected = [entry for entry in entries if entry['classification'] == 'resume-candidate' or
                    entry['classification'] == 'handoff-candidate' and config.get('handoffProfile') == 'developer' and config.get('limenConfig')][:config.get('maxResumes', 0)]
    gaps = list(inventory['errors'])
    if inventory['linkCoverage'] is not True:
        gaps.append('ledger link coverage incomplete; archive eligibility not proven')
    if not config.get('resumeWindowCommand'):
        gaps.append('resume window guard unavailable; apply will block resumes')
    result = {'schema': 'agent-mesh.lifecycle-plan.v1', 'at': inventory['at'], 'consumer': config.get('consumer', 'lifecycle'),
              'configHash': digest(config), 'inventoryHash': digest(inventory), 'complete': inventory['complete'],
              'entries': entries, 'counts': counts, 'projectCounts': projects,
              'approvals': [entry for entry in entries if entry['classification'].startswith('approval-') or entry['classification'] in ('archive-candidate', 'handoff-candidate')],
              'sourceGaps': gaps, 'actions': [{'kind': 'handoff' if entry['classification'] == 'handoff-candidate' else 'resume', **entry} for entry in selected]}
    result['digest'] = digest(result)
    return result


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def write(path, value):
    private_directory(path.parent)
    data = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + '\n'
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append(path, value):
    descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(json.dumps(value, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


@contextmanager
def locked(run_dir, consumer):
    private_directory(run_dir)
    lock_root = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'agent-mesh/lifecycle-locks'
    private_directory(lock_root)
    descriptor = os.open(lock_root / (consumer + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        scope = str(run_dir.parent.resolve())
        saved = os.read(descriptor, 8192).decode().strip()
        if saved and saved != scope:
            raise LifecycleError('consumer receipt root changed; explicit migration required')
        if not saved:
            os.write(descriptor, scope.encode())
            os.fsync(descriptor)
        yield
    except BlockingIOError:
        raise LifecycleError('another consumer apply holds the lock') from None
    finally:
        os.close(descriptor)


def receipt_history(run_dir, consumer):
    records = []
    for sibling in run_dir.parent.iterdir():
        if sibling.is_dir() and (sibling / 'plan.json').exists() and not (sibling / 'actions.jsonl').is_file():
            raise LifecycleError('persisted run has missing action receipts; deduplication unavailable')
    for path in sorted(run_dir.parent.glob('*/actions.jsonl')):
        try:
            with path.open() as stream:
                for line in stream:
                    record = json.loads(line)
                    if record.get('consumer') == consumer:
                        records.append(record)
        except (OSError, ValueError, KeyError):
            raise LifecycleError('action receipt history is unreadable; deduplication unavailable') from None
    return sorted(records, key=lambda record: record.get('at', ''))


def retry_states(records, config=None):
    states = {}
    for record in records:
        if record.get('kind') == 'archive':
            continue
        fingerprint = record.get('fingerprint')
        if not fingerprint:
            continue
        state = states.setdefault(fingerprint, {'fingerprint': fingerprint, 'attempted': False, 'deliveryStarted': False})
        state['session'] = record.get('session')
        for key in ('target', 'childNativeId', 'childSession', 'correlationId'):
            if record.get(key):
                state[key] = record[key]
        if record.get('phase') == 'attempt':
            state.update(attempted=True, failure=None)
        elif record.get('phase') == 'child-created':
            state['childCreated'] = True
        elif record.get('phase') == 'delivery-attempt':
            state['deliveryStarted'] = True
        elif record.get('phase') == 'acknowledgement':
            state['acknowledged'] = True
        elif record.get('phase') == 'failure':
            if (record.get('reason') == 'new child ownership or native identity unavailable' and state.get('target')
                    and state.get('childCreated') and not state.get('deliveryStarted') and not state.get('acknowledged')):
                try:
                    record = {**record, **retry_failure(RetryableFailure(record['reason'], 'handoff-proof'), None, config or {}, record)}
                except (ValueError, KeyError, TypeError):
                    pass
            state['failure'] = record
    return states


def child_context(states, session):
    return next((state for state in reversed(list(states.values())) if state.get('session') == session and state.get('target')), None)


def retry_ready(state, config, at):
    failure = state.get('failure') or {}
    if not failure.get('retryable') or state.get('acknowledged') or state.get('deliveryStarted'):
        return False
    if failure.get('retryClass') not in ('handoff-proof', 'capacity', 'model-capacity'):
        return False
    if failure.get('retryAttempt', 0) >= config.get('retryMaxAttempts', 3):
        return False
    try:
        return instant(at) >= instant(failure['nextRetryAt'])
    except (ValueError, KeyError, TypeError):
        return False


def attempted(run_dir, consumer, config=None, at=None):
    records = receipt_history(run_dir, consumer)
    states = retry_states(records, config)
    held = set().union(*(state['fingerprints'] for state in archive_module().history(records).values() if state['unresolved'] or state['successes']))
    return held | {fingerprint for fingerprint, state in states.items() if (state['attempted'] or (state.get('failure') or {}).get('retryable')) and not retry_ready(state, config or {}, at or now())}


def retry_failure(error, context, config, base):
    count = (context or {}).get('failure') or {}
    count = count.get('retryAttempt', 0) + 1
    delay = min(config.get('retryMaxSeconds', 3600), config.get('retryBaseSeconds', 300) * 2 ** min(count - 1, 10))
    return {'retryable': True, 'retryClass': error.retry_class, 'retryAttempt': count,
            'nextRetryAt': (instant(base['at']) + timedelta(seconds=delay)).isoformat().replace('+00:00', 'Z'),
            'retryExhausted': count >= config.get('retryMaxAttempts', 3)}


def publish_outcomes(config, records, run_dir):
    """Project acknowledged actions into the existing replayable follow outbox."""
    if not config.get('eventOutbox'):
        return
    module_path = BIN / 'agent-follow.py'
    spec = importlib.util.spec_from_file_location('lifecycle_native_follow', module_path)
    follow = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(follow)
    candidates = []
    for record in records:
        if record.get('phase') not in ('acknowledgement', 'failure') and not (record.get('kind') == 'archive' and record.get('phase') == 'skipped'):
            continue
        semantic = {key: record.get(key) for key in ('session', 'kind', 'fingerprint', 'phase', 'status', 'reason')}
        if record.get('kind') == 'archive':
            semantic['reasonCode'] = record.get('reasonCode')
        payload = {**record, 'report': str((run_dir / 'report.md').resolve())}
        candidates.append({'event_id': 'lifecycle:' + digest(semantic), 'ref': record['session'],
                           'kind': 'LIFECYCLE', 'body': str(record.get('status') or ''),
                           'timestamp': record.get('at'), 'payload': payload,
                           'selection': {'mode': 'observe', 'label': 'lifecycle'}})
    if candidates:
        root = Path(config['eventOutbox']).expanduser()
        try:
            with follow.locked(root / 'state.lock'):
                follow.append_outbox(root, candidates)
        except (OSError, ValueError, RuntimeError):
            raise LifecycleError('native action outbox unavailable; preserve receipts') from None


def recover_outcomes(config, run_dir):
    path = run_dir / 'actions.jsonl'
    if not config.get('eventOutbox') or not path.exists():
        return
    try:
        records = [json.loads(line) for line in path.read_text().splitlines()]
    except (OSError, ValueError):
        raise LifecycleError('action event recovery cannot read receipts') from None
    publish_outcomes(config, records, run_dir)


def resume_safe(config, session):
    info = query(config, 'resume', {'session': session})
    reasons = set(info.get('reasons', []))
    if info.get('resumable') is False and not reasons:
        raise LifecycleError('native resumability is unproven')
    if info.get('sessionId') != session or type(info.get('resumable')) is not bool or info.get('harness') != 'codex' or info.get('successor') or reasons - {'occupied', 'desktop-owned'} or info.get('writer', {}).get('state') not in ('free', 'occupied'):
        raise LifecycleError('native resume query blocks queueing')
    native = info.get('nativeId')
    if not isinstance(native, str) or not UUID.fullmatch(native):
        raise LifecycleError('native identity unavailable')
    code, _ = run([*command(config, 'nativeGuardCommand', [sys.executable, str(BIN / 'codex-thread-guard.py')]),
                   'resume-check', '--session', native])
    if code not in (0, 4, 6):
        raise LifecycleError('native thread guard blocks queueing')
    status, writers = run([*command(config, 'writerCommand', ['node', str(BIN / 'session-writer-status.mjs')]),
                           '--agent', 'codex', '--session', native, '--json'])
    if status or not isinstance(writers, dict) or writers.get('sessionId') != native or writers.get('agent') != 'codex' or not isinstance(writers.get('writers'), list):
        raise LifecycleError('writer status unknown')
    current = writers['writers']
    if any(not isinstance(writer, dict) or writer.get('role') != 'app-server' for writer in current):
        raise LifecycleError('concurrent CLI or unknown writer blocks queueing')
    if code == 4 and not current:
        raise LifecycleError('guard writer failure lacks exclusive app-server proof')
    return native


def handoff(config, original, base, run_dir, retry=None):
    """Create exactly one unique, owned Codex child; never resume/stop Claude."""
    if config.get('handoffProfile') != 'developer' or not isinstance(config.get('limenConfig'), str):
        raise LifecycleError('governed handoff profile or policy unavailable')
    info = query(config, 'resume', {'session': original['sessionId']})
    if info.get('sessionId') != original['sessionId'] or info.get('successor') or set(info.get('reasons', [])) - {'occupied', 'desktop-owned'} or info.get('writer', {}).get('state') not in ('free', 'occupied'):
        raise LifecycleError('original handoff source is not safely observable')
    launcher = command(config, 'sessionCommand', ['bash', str(BIN / 'agent-session.sh')])
    target = retry.get('target') if retry else 'lifecycle-' + uuid.uuid4().hex
    correlation = 'lifecycle-' + base['fingerprint'][:32]
    if retry is None:
        # A missing target is exit 3. Any unresolved/existing target blocks launch.
        code, _ = run([*launcher, '--agent', 'codex', 'target-session', target], raw=True)
        if code != 3:
            raise LifecycleError('new handoff target is not proven absent')
        append(run_dir / 'actions.jsonl', {**base, 'phase': 'attempt', 'target': target, 'correlationId': correlation})
        code, created = run([*launcher, '--agent', 'codex', '--profile', 'developer', '--limen-config', config['limenConfig'],
                             'new', original['cwd'], target], raw=True)
        if code == 75:
            # The native capacity dispatcher owns this pending target/job. Never
            # submit a second launch; later retries only probe this same target.
            raise RetryableFailure('native governed launch is waiting for capacity', 'capacity')
        if code or not isinstance(created, str) or created.splitlines()[-1:] != [target]:
            raise LifecycleError('governed Codex child launch failed; outcome ambiguous, do not retry')
        append(run_dir / 'actions.jsonl', {**base, 'phase': 'child-created', 'target': target})
    else:
        append(run_dir / 'actions.jsonl', {**base, 'phase': 'attempt', 'target': target, 'correlationId': correlation, 'reusedChild': True})
    try:
        code, native = run([*launcher, '--agent', 'codex', 'target-session', target, '--owned-cwd', original['cwd']], raw=True)
    except LifecycleError:
        raise RetryableFailure('recorded child ownership proof unavailable; no new child created', 'handoff-proof') from None
    if code or not isinstance(native, str) or not UUID.fullmatch(native):
        kind = 'capacity' if retry and (retry.get('failure') or {}).get('retryClass') == 'capacity' and code == 3 else 'handoff-proof'
        raise RetryableFailure('recorded child ownership proof unavailable; no new child created', kind)
    if retry and retry.get('childNativeId') and native != retry['childNativeId']:
        raise LifecycleError('recorded child native identity changed; held for reconciliation')
    append(run_dir / 'actions.jsonl', {**base, 'phase': 'child-identified', 'target': target, 'childNativeId': native,
                                      'childSession': 'codex:' + native, 'originalSession': original['sessionId']})
    refreshed = collect(config)
    latest = next((row for row in refreshed['sessions'] if row['sessionId'] == original['sessionId']), None)
    if not refreshed['complete'] or latest is None or fingerprint(latest) != base['fingerprint'] or classify(latest, config, now())['classification'] != 'handoff-candidate':
        raise LifecycleError('original context changed during handoff launch; child retained without prompt')
    token = hashlib.sha256(correlation.encode()).hexdigest()[:16]
    prompt = ('Original source session: ' + original['sessionId'] + '. Use the native Mesh context and linked sources '
              'to recover that original request before acting. ' + PROMPT)
    # This helper owns its pane/approval/composer checks. The owned-cwd proof
    # above permits only this newly created unattended single-pane child.
    append(run_dir / 'actions.jsonl', {**base, 'phase': 'delivery-attempt', 'target': target, 'childNativeId': native, 'correlationId': correlation})
    code, _ = run([*command(config, 'sendCommand', ['bash', str(BIN / 'agent-send.sh')]), '--quiet', '--agent', 'codex',
                    '--correlation-id', correlation, '--result-token', token, target, prompt, '5'], raw=True)
    if code not in (0, 4, 65, 124):
        raise LifecycleError('guarded child prompt delivery failed; do not retry')
    lineage = query(config, 'subgraph', {'sessions': [original['sessionId'], 'codex:' + native], 'depth': 1})
    # Native bridge hooks may expose parentage. Do not invent lineage edges.
    append(run_dir / 'actions.jsonl', {**base, 'phase': 'lineage-observed', 'target': target,
                                      'childSession': 'codex:' + native, 'edges': lineage.get('edges', [])})
    return {**base, 'phase': 'acknowledgement', 'status': 'submitted', 'target': target,
            'childNativeId': native, 'childSession': 'codex:' + native, 'originalSession': original['sessionId'],
            'correlationId': correlation}


def apply_plan(plan, inventory, config, run_dir):
    expected = plan.get('digest')
    if expected != digest({key: value for key, value in plan.items() if key != 'digest'}) or plan.get('configHash') != digest(config) or plan.get('inventoryHash') != digest(inventory):
        raise LifecycleError('persisted plan or configuration digest mismatch')
    if not plan.get('complete') or not inventory.get('complete'):
        raise LifecycleError('source errors block apply')
    actions = plan.get('actions', [])
    if sum(action.get('kind') in ('resume', 'handoff') for action in actions) > min(config.get('maxResumes', 0), 3) or sum(action.get('kind') == 'archive' for action in actions) > config.get('archiveMaxCandidates', config.get('archivePrepareLimit', 100)) or any(action.get('kind') not in ('resume', 'handoff', 'archive') for action in actions):
        raise LifecycleError('unsupported action or resume limit exceeded')
    if plan.get('archive', {}).get('status') == 'technical-error':
        raise LifecycleError('archive preparation technical error blocks apply')
    archives = [action for action in actions if action['kind'] == 'archive']
    if archives and (not 0 < config.get('maxArchives', 0) <= 10 or not all(config.get(key) for key in ('archivePrepareCommand', 'archiveReviewCommand', 'archiveApplyCommand'))):
        raise LifecycleError('archive protocol or success limit unavailable')
    outcomes = []
    with locked(run_dir, plan['consumer']):
        history = receipt_history(run_dir, plan['consumer'])
        states = retry_states(history, config)
        seen = {key for key, value in states.items() if (value['attempted'] or (value.get('failure') or {}).get('retryable')) and not retry_ready(value, config, now())}
        recover_outcomes(config, run_dir)
        archive_states = archive_module().history(history)
        for state in archive_states.values():
            if state['successes']:
                seen.update(state['fingerprints'])
        if any(state['unresolved'] for state in archive_states.values()):
            raise LifecycleError('unresolved native archive attempt requires reconciliation')
        reviewed = archive_module().review(plan, config, run_dir, archive_api()) if archives else None
        successes = sum(1 for state in archive_states.values() for plan_digest, _ in state['successes'] if plan_digest == expected)
        for action in actions:
            base = {'at': now(), 'consumer': plan['consumer'], 'session': action['session'], 'kind': action['kind'],
                    'fingerprint': action['fingerprint'], 'planDigest': expected}
            if action['kind'] == 'archive':
                base['actionDigest'] = action['actionDigest']
                prior = archive_states.get(action['session'], {})
                if (expected, action['actionDigest']) in prior.get('successes', set()):
                    outcomes.append({**base, 'phase': 'deduplicated', 'status': 'already-archived'})
                    continue
                if prior.get('successes') and action['fingerprint'] in prior.get('fingerprints', set()):
                    outcome = {**base, 'phase': 'skipped', 'status': 'skipped', 'reasonCode': 'previous_native_archive_confirmed'}
                    append(run_dir / 'actions.jsonl', outcome)
                    outcomes.append(outcome)
                    continue
                if (expected, action['actionDigest']) in prior.get('skipped', set()):
                    outcomes.append({**base, 'phase': 'deduplicated', 'status': 'already-skipped'})
                    continue
                if successes >= config['maxArchives']:
                    outcomes.append({**base, 'phase': 'deferred', 'status': 'success-limit'})
                    continue
                try:
                    decision = reviewed['decisions'][action['actionDigest']]
                    if decision['verdict'] == 'SKIP':
                        result = {'status': 'skipped', 'reasonCode': decision['reasonCode']}
                    else:
                        fresh = collect(config)
                        if not fresh.get('complete'):
                            raise LifecycleError('fresh native source errors block archive')
                        result = archive_module().apply_action(action, plan, fresh, config, run_dir, reviewed, base, archive_api())
                    outcome = {**base, 'at': now(), 'phase': 'acknowledgement' if result['status'] == 'archived' else 'skipped', **result}
                    successes += result['status'] == 'archived'
                except LifecycleError as error:
                    outcome = {**base, 'at': now(), 'phase': 'failure', 'status': 'blocked', 'reason': str(error)}
                append(run_dir / 'actions.jsonl', outcome)
                publish_outcomes(config, [outcome], run_dir)
                outcomes.append(outcome)
                if outcome['phase'] == 'failure':
                    break
                continue
            if action.get('modelCapacityScope'):
                base['modelCapacityScope'] = action['modelCapacityScope']
            if action['fingerprint'] in seen:
                outcome = {**base, 'phase': 'deduplicated', 'status': 'not-retried'}
                append(run_dir / 'actions.jsonl', outcome)
                outcomes.append(outcome)
                continue
            context = states.get(action['fingerprint'])
            try:
                retry_class = 'model-capacity' if action.get('modelCapacityScope') else (context['failure']['retryClass'] if context and retry_ready(context, config, now()) else None)
                if retry_class and config.get('retryGuardCommand'):
                    code, permission = run(config['retryGuardCommand'], {'session': action['session'], 'target': (context or {}).get('target'),
                        'retryClass': retry_class})
                    if code or not isinstance(permission, dict) or permission.get('allow') is not True:
                        raise RetryableFailure('retry held by private source or permission policy', retry_class)
                if action.get('modelCapacityScope'):
                    model_attempts = sum(record.get('phase') == 'attempt' and record.get('modelCapacityScope') == action['modelCapacityScope'] for record in history)
                    if model_attempts >= config.get('retryMaxAttempts', 3):
                        raise LifecycleError('model capacity retry hard cap reached; reconciliation required')
                    if instant(now()) < instant(action['retryability']['failureAt']) + timedelta(seconds=retry_delay(config, model_attempts)):
                        raise LifecycleError('model capacity retry is still in receipt-backed backoff')
                window = config.get('resumeWindowCommand')
                if not window:
                    raise LifecycleError('resume window guard unavailable')
                code, guard = run(window, {'session': action['session'], 'planDigest': expected, 'at': now(), 'timezone': config.get('timezone', 'UTC')})
                if code or not isinstance(guard, dict) or guard.get('allow') is not True:
                    raise LifecycleError('resume window guard blocks queueing')
                native = resume_safe(config, action['session']) if action['kind'] == 'resume' else None
                fresh = collect(config)
                if not fresh['complete']:
                    raise LifecycleError('fresh native source errors block apply')
                original = next((row for row in fresh['sessions'] if row['sessionId'] == action['session']), None)
                classification = 'handoff-candidate' if action['kind'] == 'handoff' else 'resume-candidate'
                latest = classify(original, config, now()) if original else None
                if (latest is None or fingerprint(original) != action['fingerprint']
                        or latest['classification'] != classification
                        or latest.get('workItem') != action.get('workItem')):
                    raise LifecycleError('persisted observation or work item is no longer eligible')
                if action['kind'] == 'handoff':
                    prior_child = child_context(states, action['session'])
                    if prior_child and prior_child['fingerprint'] != action['fingerprint']:
                        raise LifecycleError('recorded child belongs to another observation; held for reconciliation')
                    outcome = handoff(config, original, base, run_dir, context if context and context.get('target') else None)
                else:
                    correlation = 'lifecycle-' + action['fingerprint'][:32]
                    append(run_dir / 'actions.jsonl', {**base, 'phase': 'attempt', 'nativeId': native, 'correlationId': correlation})
                    seen.add(action['fingerprint'])
                    code, acknowledgement = run([*command(config, 'nativeCallCommand', ['node', str(BIN / 'agent-native-call.mjs')]),
                        '--agent', 'codex', '--session', native, '--delivery-only', '--resume', '--correlation-id', correlation, '--message', resume_prompt(action)])
                    if code == 75 and isinstance(acknowledgement, dict) and acknowledgement.get('status') == 'waiting_capacity' and acknowledgement.get('accepted') is False and acknowledgement.get('sessionId') == native and acknowledgement.get('correlationId') == correlation:
                        raise RetryableFailure('native queue explicitly rejected for capacity before acceptance', 'capacity')
                    if code or not isinstance(acknowledgement, dict) or acknowledgement.get('status') != 'queued' or acknowledgement.get('sessionId') != native or acknowledgement.get('correlationId') != correlation:
                        raise LifecycleError('native queue failed or acknowledgement invalid')
                    outcome = {**base, 'phase': 'acknowledgement', 'status': 'queued', 'nativeId': native, 'correlationId': correlation,
                               'resumeRequested': True, 'resumeVerified': False,
                               'resumeDiagnostic': acknowledgement.get('resumeDiagnostic', False)}
            except LifecycleError as error:
                observed_at = now()
                outcome = {**base, 'at': observed_at, 'actionStartedAt': base['at'], 'failureObservedAt': observed_at,
                           'phase': 'failure', 'status': 'blocked', 'reason': str(error)}
                if isinstance(error, RetryableFailure):
                    outcome.update(retry_failure(error, context, config, outcome))
                append(run_dir / 'actions.jsonl', outcome)
                publish_outcomes(config, [outcome], run_dir)
                outcomes.append(outcome)
                break
            append(run_dir / 'actions.jsonl', outcome)
            publish_outcomes(config, [outcome], run_dir)
            outcomes.append(outcome)
    return outcomes


def report(inventory, plan, outcomes=()):
    lines = ['# Lifecycle report', '', f"Known native identities: {len(inventory['sessions'])}. Complete inventory: {inventory['complete']}.",
             'Queue acknowledgement means queued; execution and completion are unverified.', '', '| Classification | Count |', '| --- | ---: |']
    lines += [f'| {key} | {count} |' for key, count in sorted(plan['counts'].items())]
    lines += ['', '| Project | Count |', '| --- | ---: |']
    lines += [f'| {key} | {count} |' for key, count in sorted(plan['projectCounts'].items())]
    lines += ['', '## Decisions and source gaps', '']
    lines += ['- ' + gap for gap in plan['sourceGaps']]
    for entry in plan['entries']:
        lines.append(f"- {entry['session']}: {entry['classification']} — {entry['reason']}")
        retry = entry.get('retry') or entry.get('retryability')
        if retry:
            lines.append(f"  - Retry {retry.get('retryClass')}: due {retry.get('nextRetryAt')}; attempt {retry.get('retryAttempt', 0)}; exhausted {retry.get('retryExhausted', False)}")
        if entry.get('workItem'):
            item = entry['workItem']
            lines.append(f"  - Item {item['item']}: {item['title']}; next step: {item['nextStep']}")
        lines.extend('  - ' + gap for gap in entry['sourceGaps'])
    if plan.get('archive'):
        batch = plan['archive']
        lines += ['', '## Archive preparation', '', f"Status: {batch['status']}; prepared: {len(batch['prepared'])}; success limit: {batch['successLimit']}."]
        lines.extend(f"- {entry['session']}: skipped ({entry['reasonCode']})" for entry in batch['skipped'])
        if batch.get('reason'):
            lines.append('- Technical stop: ' + batch['reason'])
    if outcomes:
        lines += ['', '## Apply receipts', '']
        lines.extend(f"- {entry['session']}: {entry['status']}" for entry in outcomes)
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('inventory', 'plan', 'apply'))
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--apply', action='store_true', help='authorize native queue mutations for persisted plan')
    args = parser.parse_args()
    outcome, failure = 'noop', None
    try:
        config = validate_config(json.loads(args.config.read_text()))
        private_directory(args.run_dir)
        if args.operation == 'apply':
            inventory = json.loads((args.run_dir / 'inventory.json').read_text())
            plan = json.loads((args.run_dir / 'plan.json').read_text())
            if not args.apply:
                raise LifecycleError('apply requires explicit --apply')
            outcomes = apply_plan(plan, inventory, config, args.run_dir)
            outcome = 'blocked' if any(entry['phase'] == 'failure' for entry in outcomes) else 'acted' if any(entry['status'] in ('queued', 'submitted', 'archived') for entry in outcomes) else 'noop'
            write(args.run_dir / 'report.md', report(inventory, plan, outcomes))
        else:
            if (args.run_dir / 'plan.json').exists():
                raise LifecycleError('use a new run directory; persisted plans are immutable')
            inventory = collect(config, args.full)
            history = receipt_history(args.run_dir, config.get('consumer', 'lifecycle'))
            plan = build_plan(inventory, config, attempted(args.run_dir, config.get('consumer', 'lifecycle'), config), history)
            write(args.run_dir / 'inventory.json', inventory)
            if args.operation == 'plan':
                plan = archive_module().prepare(plan, inventory, config, args.run_dir, archive_api(), history)
                plan['counts'] = dict(Counter(entry['classification'] for entry in plan['entries']))
                plan['digest'] = digest({key: value for key, value in plan.items() if key != 'digest'})
            write(args.run_dir / 'plan.json', plan)
            append(args.run_dir / 'actions.jsonl', {'at': now(), 'consumer': plan['consumer'], 'phase': 'planned', 'planDigest': plan['digest']})
            write(args.run_dir / 'report.md', report(inventory, plan))
            outcome = 'noop' if inventory['complete'] and plan.get('archive', {}).get('status') != 'technical-error' else 'blocked'
        result = {'status': outcome, 'runDir': str(args.run_dir), 'planDigest': plan['digest']}
    except (LifecycleError, OSError, ValueError, KeyError, TypeError) as error:
        failure, outcome = str(error), 'failed'
        result = {'status': outcome, 'error': failure}
    if 'config' in locals():
        try:
            code, _ = run([*command(config, 'runReceiptCommand', [sys.executable, str(BIN / 'agent-run-receipt.py')]),
                           'record', '--job', config.get('consumer', 'lifecycle'), '--outcome', outcome, '--trigger', 'manual',
                           '--note', 'Lifecycle observation or native queue acknowledgement; execution unverified.'])
            if code:
                failure = 'run receipt helper failed'
        except LifecycleError:
            failure = 'run receipt helper unavailable'
    if failure:
        result.update(status='failed', error=failure)
    print(json.dumps(result))
    return 1 if failure or outcome in ('failed', 'blocked') else 0


if __name__ == '__main__':
    raise SystemExit(main())
