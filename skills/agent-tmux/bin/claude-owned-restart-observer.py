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
_launch_spec = importlib.util.spec_from_file_location('claude_launch_evidence', _here / 'claude-launch-evidence.py')
_launch = importlib.util.module_from_spec(_launch_spec)
_launch_spec.loader.exec_module(_launch)


def observe_owned_restart(*, writer_pid, pane_pid, session, trusted_executable,
                          transcript_root, frame, state_sha256, profile_sha256, handover_id,
                          launch_id, source_session, generation, read_checkpoint,
                          node_executable, target=None):
    if (not isinstance(frame, str) or len(frame.encode('utf-8')) > 1024 * 1024 + 256
            or not isinstance(state_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', state_sha256)
            or not isinstance(profile_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', profile_sha256)
            or not all(isinstance(x, str) and x for x in (handover_id, launch_id, source_session))
            or type(generation) is not int or generation < 1 or not callable(read_checkpoint)
            or not isinstance(node_executable, str) or not os.path.isabs(node_executable)
            or (target is not None and (not isinstance(target, str) or not re.fullmatch(r'[a-z0-9-]+', target)))):
        raise ValueError('invalid observation request')
    expected = {'id': launch_id, 'handoverId': handover_id, 'session': source_session,
                'generation': generation, 'status': 'invoking', 'stateSha256': state_sha256,
                'successorSession': session, 'profileSha256': profile_sha256}

    def checkpoint():
        state = read_checkpoint()
        if not isinstance(state, dict) or any(state.get(k) != v for k, v in expected.items()):
            raise RuntimeError('successor checkpoint mismatch')
        return {k: state[k] for k in expected}

    def check_target():
        if target is None:
            return
        env = os.environ.copy()
        env.pop('AGENT_WRITER_PROC_ROOT', None)
        result = subprocess.run([str(_here / 'agent-session.sh'), '--agent', 'claude',
                                 'target-status', target, '--writer-pid', str(writer_pid), '--json'],
                                capture_output=True, text=True, timeout=8, env=env, check=False)
        if result.returncode != 0 or len(result.stdout) > 4096:
            raise RuntimeError('target ownership unavailable')
        try:
            proof = json.loads(result.stdout)
        except (TypeError, ValueError) as exc:
            raise RuntimeError('invalid target ownership') from exc
        if proof != {'target': target, 'pane_pid': pane_pid, 'writer_pid': writer_pid}:
            raise RuntimeError('target ownership mismatch')

    with _owned.OwnedClaudeProcess(writer_pid, pane_pid, session, trusted_executable) as lease:
        check_target()
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
        check_target()
        if lease.verify() != first:
            raise RuntimeError('process identity changed during observation')
        return {'schema': 'agent-mesh.claude-owned-restart-observation.v1',
                'checkpoint': expected, 'process': first, 'observation': proof,
                **({'target': target} if target is not None else {})}


def _main():
    # Internal graph child: the parent holds the graph lock and supplies the
    # checkpoint. Never invoke as evidence of caller authority on its own.
    import sys
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('request too large')
        data = json.loads(raw)
        checkpoint = data['checkpoint']
        request = data['request']
        if not request.get('target'):
            raise ValueError('target required')
        socket = os.environ.get('MESH_TMUX_SOCKET') or 'mesh'
        with _launch.launch_evidence(request['launchRecordPath'], launch_id=checkpoint['bridgeLaunchId'],
                                     target=request['target'], socket=socket,
                                     session=request['session']) as launch:
            result = observe_owned_restart(
                writer_pid=request['writerPid'], pane_pid=request['panePid'],
                session=request['session'], trusted_executable=request['trustedExecutable'],
                transcript_root=request['transcriptRoot'], frame=request['frame'],
                state_sha256=request['stateSha256'], profile_sha256=request['profileSha256'],
                handover_id=request['handoverId'], launch_id=request['launchId'],
                source_session=request['sourceSession'], generation=request['generation'],
                read_checkpoint=lambda: checkpoint, node_executable=data['nodeExecutable'],
                target=request['target'])
            result['checkpoint']['bridgeLaunchId'] = checkpoint['bridgeLaunchId']
            result['launch'] = launch
        print(json.dumps(result, separators=(',', ':')))
    except Exception:
        print('owned restart observation failed', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    _main()
