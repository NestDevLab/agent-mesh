/** Reconcile session-bound triggers through an operator-provided CAS adapter. */
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

// begin must atomically reserve this ID and trigger set, rejecting unresolved
// overlapping transactions. Each write must be durable before it resolves.
// The adapter atomically compares target AND version and stores operationId.
export async function reconcileTriggers({ triggers, from, to, transactionId, adapter, journal, dryRun = true }) {
  if (!Array.isArray(triggers) || triggers.length > 256 || !token(from) || !token(to) || from === to || !token(transactionId) || transactionId.length > 90 || typeof dryRun !== 'boolean' || typeof adapter?.read !== 'function' || typeof adapter?.move !== 'function' || typeof journal?.begin !== 'function' || typeof journal?.write !== 'function') throw new Error('invalid trigger transaction');
  const seen = new Set();
  for (const trigger of triggers) {
    if (!token(trigger?.kind) || !token(trigger?.id) || seen.has(`${trigger.kind}\0${trigger.id}`)) throw new Error('invalid or duplicate trigger');
    seen.add(`${trigger.kind}\0${trigger.id}`);
  }
  const receipt = { schema: 'agent-mesh.trigger-transaction.v1', id: transactionId, from, to, dryRun, status: 'planning', triggers: [] };
  await journal.begin({ id: transactionId, triggers: structuredClone(triggers), dryRun });
  const save = () => journal.write(structuredClone(receipt));
  for (const trigger of triggers) {
    const current = await adapter.read(trigger);
    if (!current || current.target !== from || !token(current.version)) throw new Error('trigger source or version not verified');
    receipt.triggers.push({ kind: trigger.kind, id: trigger.id, before: current.version, status: 'planned' });
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
    if (response?.status !== 'applied' || !token(response.version)) {
      row.status = response?.status === 'not-applied' ? 'not-applied' : 'uncertain';
      receipt.status = row.status === 'uncertain' ? 'uncertain' : 'rolling-back'; await save();
      if (row.status === 'uncertain') return receipt;
      for (let j = i - 1; j >= 0; j--) {
        const prior = receipt.triggers[j], rollbackId = `${transactionId}:rollback:${j}`;
        prior.status = 'rolling-back'; await save();
        let rollback;
        try { rollback = await adapter.move({ kind: prior.kind, id: prior.id, expectedTarget: to, expectedVersion: prior.after, target: from, operationId: rollbackId }); }
        catch { prior.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
        if (rollback?.status !== 'applied' || !token(rollback.version)) { prior.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
        const observed = await adapter.read(prior);
        if (observed?.target !== from || observed.version !== rollback.version || observed.lastOperationId !== rollbackId) { prior.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
        prior.status = 'rolled-back'; prior.rollbackVersion = rollback.version; await save();
      }
      receipt.status = 'rolled-back'; await save(); return receipt;
    }
    const observed = await adapter.read(row);
    if (observed?.target !== to || observed.version !== response.version || observed.lastOperationId !== operationId) { row.status = 'uncertain'; receipt.status = 'uncertain'; await save(); return receipt; }
    row.after = response.version; row.status = 'verified'; await save();
  }
  receipt.status = 'verified'; await save(); return receipt;
}
