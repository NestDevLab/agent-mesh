#!/usr/bin/env python3
"""Experimental read-only local restart observation while holding process leases.

The caller must authenticate checkpoint reads, executable and node binary. This
observation is not a settlement, an authorization, a global singleton proof,
or evidence that the message was acted on. It performs no handover or mutation.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

_here = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('claude_owned_process', _here / 'claude-owned-process.py')
_owned = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_owned)


def observe_owned_restart(*, writer_pid, pane_pid, session, trusted_executable,
                          transcript_root, frame, state_sha256, profile_sha256, handover_id,
                          launch_id, source_session, generation, read_checkpoint,
                          node_executable):
    if (not isinstance(frame, str) or len(frame.encode('utf-8')) > 1024 * 1024 + 256
            or not isinstance(state_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', state_sha256)
            or not isinstance(profile_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', profile_sha256)
            or not all(isinstance(x, str) and x for x in (handover_id, launch_id, source_session))
            or type(generation) is not int or generation < 1 or not callable(read_checkpoint)
            or not isinstance(node_executable, str) or not os.path.isabs(node_executable)):
        raise ValueError('invalid observation request')
    expected = {'id': launch_id, 'handoverId': handover_id, 'session': source_session,
                'generation': generation, 'status': 'invoking', 'stateSha256': state_sha256,
                'successorSession': session, 'profileSha256': profile_sha256}

    def checkpoint():
        state = read_checkpoint()
        if not isinstance(state, dict) or any(state.get(k) != v for k, v in expected.items()):
            raise RuntimeError('successor checkpoint mismatch')
        return {k: state[k] for k in expected}

    with _owned.OwnedClaudeProcess(writer_pid, pane_pid, session, trusted_executable) as lease:
        checkpoint()
        first = lease.verify()
        request = {'root': transcript_root, 'session': session, 'frame': frame,
                   'expectedStateSha256': state_sha256}
        result = subprocess.run([node_executable, str(_here / 'claude-owned-restart-observer.mjs')],
                                input=json.dumps(request, ensure_ascii=False), text=True,
                                capture_output=True, timeout=15, check=False)
        if result.returncode != 0 or len(result.stdout) > 4096:
            raise RuntimeError('restart transcript observation failed')
        try:
            proof = json.loads(result.stdout)
        except (ValueError, TypeError) as exc:
            raise RuntimeError('invalid transcript observation') from exc
        if (not isinstance(proof, dict) or proof.get('schema') != 'agent-mesh.claude-restart-observation.v1'
                or proof.get('session') != session or proof.get('stateSha256') != state_sha256
                or proof.get('frameSha256') != hashlib.sha256(frame.encode('utf-8')).hexdigest()
                or not re.fullmatch(r'[a-f0-9]{64}', proof.get('transcriptSha256', ''))
                or type(proof.get('transcriptBytes')) is not int or proof['transcriptBytes'] < 1):
            raise RuntimeError('transcript observation mismatch')
        checkpoint()
        if lease.verify() != first:
            raise RuntimeError('process identity changed during observation')
        return {'schema': 'agent-mesh.claude-owned-restart-observation.v1',
                'checkpoint': expected, 'process': first, 'observation': proof}
