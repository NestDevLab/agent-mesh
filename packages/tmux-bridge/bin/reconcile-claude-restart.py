#!/usr/bin/env python3
"""Reconcile an unknown local restart delivery from a graph-held observation.

This records transcript appearance only, not model execution. Caller must trust
its graph, launch journal, executable and transcript roots. The delivery stays
unknown: it never unblocks the queue, dispatches, or settles a handover.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

BIN = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mesh_comms', BIN / 'mesh-comms.py')
comms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comms)


def reconcile(*, delivery_id, graph_state, channel, writer_pid, pane_pid,
              trusted_executable, transcript_root, launch_record):
    if (not isinstance(delivery_id, str) or not re.fullmatch(r'[a-f0-9]{64}', delivery_id)
            or not isinstance(channel, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', channel)
            or type(writer_pid) is not int or writer_pid < 1 or type(pane_pid) is not int or pane_pid < 1
            or any(not isinstance(v, str) or not os.path.isabs(v) for v in
                   (graph_state, trusted_executable, transcript_root, launch_record))):
        raise ValueError('invalid reconciliation request')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('node unavailable')
    graph = str(BIN / 'mesh-graph.mjs')

    def call(args, input_value=None):
        result = subprocess.run([node, graph, '--state', graph_state, *args],
                                input=json.dumps(input_value, ensure_ascii=False) if input_value is not None else None,
                                text=True, capture_output=True, timeout=30, check=False)
        if result.returncode != 0 or len(result.stdout) > 2 * 1024 * 1024:
            raise RuntimeError('graph observation unavailable')
        try:
            return json.loads(result.stdout)
        except (TypeError, ValueError) as exc:
            raise RuntimeError('invalid graph observation') from exc

    with comms.locked() as (db, _):
        row = db.execute('SELECT digest,status,payload FROM deliveries WHERE id=?', (delivery_id,)).fetchone()
        if not row or row[1] != 'unknown' or not row[2]:
            raise ValueError('unknown delivery unavailable')
        try:
            request = comms.validate(json.loads(row[2]))
        except (TypeError, ValueError) as exc:
            raise ValueError('stored delivery invalid') from exc
        if (request.get('kind') != 'tmux' or request.get('runtime') != 'claude' or request.get('message_stdin') is not True
                or not isinstance(request.get('socket'), str) or not request['socket']
                or comms.identity(request) != delivery_id
                or hashlib.sha256(comms.encode(request).encode()).hexdigest() != row[0]):
            raise ValueError('stored delivery identity mismatch')
        # The graph observer and target-status must inspect the same socket.
        if request['socket'] != (os.environ.get('MESH_TMUX_SOCKET') or 'mesh'):
            raise ValueError('tmux socket mismatch')
        current = call(['channel', 'get', '--name', channel]).get('channel')
        checkpoint = current.get('successorLaunch') if isinstance(current, dict) else None
        if not isinstance(checkpoint, dict) or current.get('phase') != 'handover' or checkpoint.get('status') != 'invoking':
            raise ValueError('invoking checkpoint unavailable')
        graph_request = {'writerPid': writer_pid, 'panePid': pane_pid, 'session': checkpoint.get('successorSession'),
                         'trustedExecutable': trusted_executable, 'transcriptRoot': transcript_root,
                         'frame': request['message'], 'target': request['destination'], 'launchRecordPath': launch_record,
                         'stateSha256': checkpoint.get('stateSha256'), 'profileSha256': checkpoint.get('profileSha256'),
                         'handoverId': checkpoint.get('handoverId'), 'launchId': checkpoint.get('id'),
                         'sourceSession': checkpoint.get('session'), 'generation': checkpoint.get('generation')}
        proof = call(['channel', 'observe-owned-restart', '--name', channel, '--input', '-'], graph_request)
        observation = proof.get('observation') if isinstance(proof, dict) else None
        bound = proof.get('checkpoint') if isinstance(proof, dict) else None
        launch = proof.get('launch') if isinstance(proof, dict) else None
        process = proof.get('process') if isinstance(proof, dict) else None
        if (not isinstance(proof, dict) or proof.get('schema') != 'agent-mesh.claude-owned-restart-observation.v1'
                or not isinstance(observation, dict) or not isinstance(bound, dict) or not isinstance(launch, dict) or not isinstance(process, dict)
                or any(bound.get(k) != checkpoint.get(k) for k in ('id', 'handoverId', 'session', 'generation', 'status', 'stateSha256', 'profileSha256', 'successorSession', 'bridgeLaunchId'))
                or proof.get('target') != request['destination'] or launch.get('socket') != request['socket']
                or launch.get('launchId') != checkpoint.get('bridgeLaunchId')
                or launch.get('requestedSession') != checkpoint.get('successorSession')
                or process.get('session') != checkpoint.get('successorSession') or process.get('writerPid') != writer_pid or process.get('panePid') != pane_pid
                or observation.get('stateSha256') != checkpoint.get('stateSha256')
                or observation.get('session') != checkpoint.get('successorSession')
                or observation.get('frameSha256') != hashlib.sha256(request['message'].encode()).hexdigest()):
            raise ValueError('restart proof does not match delivery')
        latest = call(['channel', 'get', '--name', channel]).get('channel')
        if not isinstance(latest, dict) or latest.get('phase') != 'handover' or latest.get('successorLaunch') != checkpoint:
            raise ValueError('checkpoint changed after observation')
        # Retain the private payload; no replay or flush is performed here.
        db.execute('CREATE TABLE IF NOT EXISTS restart_reconciliation (delivery_id TEXT PRIMARY KEY, at REAL NOT NULL, proof TEXT NOT NULL)')
        if db.execute('SELECT 1 FROM restart_reconciliation WHERE delivery_id=?', (delivery_id,)).fetchone():
            raise ValueError('delivery already observed')
        latest_row = db.execute('SELECT digest,status,payload FROM deliveries WHERE id=?', (delivery_id,)).fetchone()
        if latest_row != row:
            raise ValueError('delivery changed during reconciliation')
        db.execute('INSERT INTO restart_reconciliation(delivery_id,at,proof) VALUES (?,?,?)',
                   (delivery_id, time.time(), json.dumps(proof, separators=(',', ':'), sort_keys=True)))
        db.commit()
        return {'schema': 'agent-mesh.restart-reconciliation.v1', 'deliveryId': delivery_id,
                'status': 'transcript-observed', 'delivery': 'unknown', 'execution': 'unverified', 'handover': 'unchanged'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delivery-id', required=True)
    parser.add_argument('--graph-state', required=True)
    parser.add_argument('--channel', required=True)
    parser.add_argument('--writer-pid', type=int, required=True)
    parser.add_argument('--pane-pid', type=int, required=True)
    parser.add_argument('--trusted-executable', required=True)
    parser.add_argument('--transcript-root', required=True)
    parser.add_argument('--launch-record', required=True)
    args = parser.parse_args()
    result = reconcile(delivery_id=args.delivery_id, graph_state=args.graph_state, channel=args.channel,
                       writer_pid=args.writer_pid, pane_pid=args.pane_pid, trusted_executable=args.trusted_executable,
                       transcript_root=args.transcript_root, launch_record=args.launch_record)
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('restart reconciliation failed; delivery remains unresolved', file=sys.stderr)
        sys.exit(1)
