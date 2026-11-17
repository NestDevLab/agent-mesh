#!/usr/bin/env python3
"""Stop an owned isolated successor after an unsafe role-start assessment.

This is an experimental, in-process coordinator, not a handover controller or
an authorization boundary. The caller must bind the assessment to the native
connection and the stop callback to that successor's owned namespace lease.
No channel, trigger, predecessor or remote state is changed here.
"""
import copy
import re
import threading


SESSION = re.compile(r'^codex:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)


class IsolatedRoleRollback:
    def __init__(self, expected_session, stop_owned_successor):
        if not isinstance(expected_session, str) or not SESSION.fullmatch(expected_session) or not callable(stop_owned_successor):
            raise ValueError('invalid isolated successor binding')
        self._session = expected_session
        self._stop = stop_owned_successor
        self._lock = threading.Lock()
        self._receipt = None

    def apply(self, assessment):
        if (not isinstance(assessment, dict) or assessment.get('schema') != 'agent-mesh.codex-role-start-assessment.v1'
                or assessment.get('session') != self._session or assessment.get('status') not in ('observed-incomplete', 'rollback-required')
                or not isinstance(assessment.get('failures'), list)
                or any(not isinstance(item, str) or not item for item in assessment['failures'])):
            raise ValueError('invalid or mismatched role assessment')
        if assessment['status'] == 'rollback-required' and not assessment['failures']:
            raise ValueError('rollback requires a stated failure')
        if assessment['status'] == 'observed-incomplete' and assessment['failures']:
            raise ValueError('inconsistent incomplete assessment')
        with self._lock:
            if self._receipt is not None:
                return copy.deepcopy(self._receipt)
            if assessment['status'] == 'observed-incomplete':
                return {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'blocked-incomplete',
                        'session': self._session, 'handover': 'blocked'}
            # Mark the attempt before invoking the callback: a lost response must
            # never cause a second stop against an uncertain process identity.
            self._receipt = {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'stop-uncertain',
                             'session': self._session, 'handover': 'blocked'}
            try:
                receipt = self._stop()
            except Exception:
                return copy.deepcopy(self._receipt)
            if (isinstance(receipt, dict) and receipt.get('schema') == 'agent-mesh.isolated-namespace-stop.v1'
                    and receipt.get('status') == 'init-exited' and receipt.get('descendants') == 'unverified'
                    and receipt.get('remoteEffects') == 'unverified'):
                self._receipt = {'schema': 'agent-mesh.isolated-role-rollback.v1', 'status': 'local-init-exited',
                                 'session': self._session, 'handover': 'blocked', 'namespaceStop': copy.deepcopy(receipt)}
            return copy.deepcopy(self._receipt)
