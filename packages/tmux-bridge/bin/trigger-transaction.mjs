/** Reconcile session-bound triggers through an operator-provided CAS adapter. */
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

// begin must atomically reserve this ID and trigger set, rejecting unresolved
// overlapping transactions. Each write must be durable before it resolves.
// The adapter atomically compares target AND version and stores operationId.
// Every applied move, including a same-target move, must produce a fresh version.
// Versions must never be reused: recovery fences delayed in-flight moves with CAS.
export async function reconcileTriggers({ triggers, from, to, transactionId, adapter, journal, dryRun = true }) {
  if (!Array.isArray(triggers) || triggers.length > 256 || !token(from) || !token(to) || from === to || !token(transactionId) || transactionId.length > 90 || typeof dryRun !== 'boolean' || typeof adapter?.read !== 'function' || typeof adapter?.move !== 'function' || typeof journal?.begin !== 'function' || typeof journal?.write !== 'function') throw new Error('invalid trigger transaction');
  const seen = new Set();
  for (const trigger of triggers) {
    if (!token(trigger?.kind) || !token(trigger?.id) || seen.has(`${trigger.kind}\0${trigger.id}`)) throw new Error('invalid or duplicate trigger');
    seen.add(`${trigger.kind}\0${trigger.id}`);
  }
  const receipt = { schema: 'agent-mesh.trigger-transaction.v1', id: transactionId, from, to, dryRun, status: 'planning', triggers: triggers.map(({ kind, id }) => ({ kind, id, status: 'pending' })) };
  await journal.begin({ id: transactionId, triggers: structuredClone(triggers), dryRun });
  const save = () => journal.write(structuredClone(receipt));
  for (let i = 0; i < triggers.length; i++) {
    let current;
    try { current = await adapter.read(triggers[i]); } catch { /* No mutation has been attempted. */ }
    if (!current || current.target !== from || !token(current.version)) {
      receipt.triggers[i].status = 'unverified';
      receipt.status = 'not-applied';
      receipt.reason = 'trigger source or version not verified';
      await save();
      return receipt;
    }
    receipt.triggers[i].before = current.version;
    receipt.triggers[i].status = 'planned';
  }
  receipt.status = dryRun ? 'dry-run' : 'applying';
  await save();
  if (dryRun) return receipt;
  for (let i = 0; i < receipt.triggers.length; i++) {
    const row = receipt.triggers[i], operationId = `${transactionId}:${i}`;
    row.status = 'applying'; row.operationId = operationId; await save();
    let response;
    try { response = await adapter.move({ kind: row.kind, id: row.id, expectedTarget: from, expectedVersion: row.before, target: to, operationId }); }
    catch { row.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
    if (response?.status !== 'applied' || !token(response.version) || response.version === row.before) {
      row.status = response?.status === 'not-applied' ? 'not-applied' : 'uncertain';
      receipt.status = row.status === 'uncertain' ? 'uncertain' : 'rolling-back'; await save();
      if (row.status === 'uncertain') return receipt;
      for (let j = i - 1; j >= 0; j--) {
        const prior = receipt.triggers[j], rollbackId = `${transactionId}:rollback:${j}`;
        prior.status = 'rolling-back'; await save();
        let rollback;
        try { rollback = await adapter.move({ kind: prior.kind, id: prior.id, expectedTarget: to, expectedVersion: prior.after, target: from, operationId: rollbackId }); }
        catch { prior.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
        if (rollback?.status !== 'applied' || !token(rollback.version) || rollback.version === prior.after) { prior.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
        let observed;
        try { observed = await adapter.read(prior); } catch { /* The rollback may have applied. */ }
        if (observed?.target !== from || observed.version !== rollback.version || observed.lastOperationId !== rollbackId) { prior.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
        prior.status = 'rolled-back'; prior.rollbackVersion = rollback.version; await save();
      }
      receipt.status = 'rolled-back'; await save(); return receipt;
    }
    let observed;
    try { observed = await adapter.read(row); } catch { /* The move may have applied. */ }
    if (observed?.target !== to || observed.version !== response.version || observed.lastOperationId !== operationId) { row.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
    row.after = response.version; row.status = 'verified'; await save();
  }
  receipt.status = 'verified'; await save(); return receipt;
}

/** Explicitly roll back an uncertain transaction after inspecting all targets. */
export async function recoverUncertainTriggers({ transactionId, adapter, journal }) {
  if (!token(transactionId) || typeof adapter?.read !== 'function' || typeof adapter?.move !== 'function' || typeof journal?.withRecovery !== 'function') throw new Error('invalid trigger recovery');
  return journal.withRecovery(transactionId, async (receipt, save) => {
    if (receipt.id !== transactionId || receipt.status !== 'uncertain' || receipt.dryRun !== false || !Array.isArray(receipt.triggers)) throw new Error('invalid uncertain receipt');
    const observations = [];
    for (let i = 0; i < receipt.triggers.length; i++) {
      const row = receipt.triggers[i], observed = await adapter.read(row);
      if (!observed || !token(observed.version)) throw new Error('trigger observation unavailable');
      const forwardId = `${transactionId}:${i}`, rollbackId = `${transactionId}:rollback:${i}`;
      if (observed.target === receipt.from && observed.version === row.before) observations.push({ kind: 'unchanged', observed });
      else if (observed.target === receipt.from && observed.lastOperationId === rollbackId && (!row.rollbackVersion || row.rollbackVersion === observed.version)) observations.push({ kind: 'rolled-back', observed });
      else if (observed.target === receipt.to && observed.lastOperationId === forwardId && (!row.after || row.after === observed.version)) observations.push({ kind: 'moved', observed });
      else throw new Error('trigger changed outside transaction');
    }
    for (let i = receipt.triggers.length - 1; i >= 0; i--) {
      const row = receipt.triggers[i], { kind, observed } = observations[i];
      if (kind === 'rolled-back') {
        if (observed.version === row.before) throw new Error('rollback version is not a fence');
        row.status = 'rolled-back'; row.rollbackVersion = observed.version;
        continue;
      }
      const operationId = `${transactionId}:rollback:${i}`;
      if (kind === 'moved') row.after = observed.version;
      row.status = 'rolling-back'; receipt.status = 'rolling-back'; await save(receipt);
      let result, confirmed;
      try {
        result = await adapter.move({ kind: row.kind, id: row.id, expectedTarget: kind === 'moved' ? receipt.to : receipt.from, expectedVersion: observed.version, target: receipt.from, operationId });
        if (result?.status === 'applied' && token(result.version)) confirmed = await adapter.read(row);
      } catch { /* The outcome may have been applied. */ }
      if (confirmed?.target !== receipt.from || confirmed.version !== result?.version || confirmed.version === observed.version || confirmed.lastOperationId !== operationId) {
        row.status = 'uncertain'; receipt.status = 'uncertain'; await save(receipt); return receipt;
      }
      row.status = 'rolled-back'; row.rollbackVersion = result.version; await save(receipt);
    }
    receipt.status = 'rolled-back'; await save(receipt); return receipt;
  });
}
