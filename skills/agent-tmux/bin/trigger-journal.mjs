/** Private crash-conservative journal for trigger transactions. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const terminal = new Set(['verified', 'rolled-back', 'dry-run', 'not-applied']);
const statuses = new Set(['planning', 'applying', 'rolling-back', 'uncertain', ...terminal]);
const key = trigger => JSON.stringify([trigger.kind, trigger.id]);

export function triggerJournal(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('invalid journal root');
  const checkRoot = () => {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || realpathSync(root) !== root) throw new Error('journal root must be private and canonical');
  };
  const file = join(root, 'trigger-transactions.json'), lock = join(root, '.trigger-transactions.lock');
  const syncRoot = () => { const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const load = () => {
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return { schema: 'agent-mesh.trigger-journal.v1', entries: [] }; throw error; }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 8 * 1024 * 1024) throw new Error('invalid journal file');
      const data = JSON.parse(readFileSync(fd, 'utf8'));
      if (data?.schema !== 'agent-mesh.trigger-journal.v1' || !Array.isArray(data.entries) || new Set(data.entries.map(entry => entry?.id)).size !== data.entries.length || data.entries.some(entry => !token(entry?.id) || typeof entry.dryRun !== 'boolean' || !Array.isArray(entry.triggers) || entry.triggers.some(t => !token(t?.kind) || !token(t?.id)) || new Set(entry.triggers.map(key)).size !== entry.triggers.length || !statuses.has(entry.status) || (entry.epoch !== undefined && (!Number.isSafeInteger(entry.epoch) || entry.epoch < 0)))) throw new Error('invalid journal content');
      return data;
    } finally { closeSync(fd); }
  };
  const save = data => {
    const body = `${JSON.stringify(data)}\n`;
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('journal is too large');
    const temporary = join(root, `.trigger-journal-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); syncRoot();
  };
  const transaction = operation => {
    checkRoot();
    let fd;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('journal lock held or requires recovery'); throw error; }
    try { fsyncSync(fd); syncRoot(); const data = load(); const result = operation(data); save(data); return result; }
    finally {
      const owned = fstatSync(fd); closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('journal lock changed');
      unlinkSync(lock); syncRoot();
    }
  };
  return {
    async begin({ id, triggers, dryRun }) {
      if (!token(id) || !Array.isArray(triggers) || typeof dryRun !== 'boolean' || triggers.some(t => !token(t?.kind) || !token(t?.id)) || new Set(triggers.map(key)).size !== triggers.length) throw new Error('invalid journal reservation');
      return transaction(data => {
        if (data.entries.some(entry => entry.id === id)) throw new Error('transaction already reserved');
        const requested = new Set(triggers.map(key));
        if (data.entries.some(entry => !terminal.has(entry.status) && entry.triggers.some(trigger => requested.has(key(trigger))))) throw new Error('overlapping transaction unresolved');
        data.entries.push({ id, dryRun, status: 'planning', triggers: structuredClone(triggers), receipt: null, epoch: 0 });
        return 0;
      });
    },
    async write(receipt, epoch = 0) {
      return transaction(data => {
        const entry = data.entries.find(item => item.id === receipt?.id);
        if (!entry || (entry.epoch ?? 0) !== epoch || terminal.has(entry.status) || receipt.schema !== 'agent-mesh.trigger-transaction.v1' || receipt.dryRun !== entry.dryRun || !statuses.has(receipt.status) || !Array.isArray(receipt.triggers) || JSON.stringify(receipt.triggers.map(key)) !== JSON.stringify(entry.triggers.map(key))) throw new Error('invalid journal update');
        entry.status = receipt.status; entry.receipt = structuredClone(receipt);
      });
    },
    async get(id) {
      checkRoot();
      if (!token(id)) throw new Error('invalid transaction id');
      const entry = load().entries.find(item => item.id === id);
      return entry ? structuredClone(entry) : null;
    },
    async withRecovery(id, callback) {
      checkRoot();
      if (!token(id) || typeof callback !== 'function') throw new Error('invalid recovery request');
      const recoveryLock = join(root, `.trigger-recovery-${createHash('sha256').update(id).digest('hex')}.lock`);
      let fd;
      try { fd = openSync(recoveryLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('recovery lock held or requires reconciliation'); throw error; }
      try {
        fsyncSync(fd); syncRoot();
        const journal = triggerJournal(root);
        const takeover = transaction(data => {
          const entry = data.entries.find(item => item.id === id);
          if (!entry || entry.dryRun || !['uncertain', 'applying', 'rolling-back'].includes(entry.status) || !entry.receipt) throw new Error('transaction not recoverable');
          const epoch = (entry.epoch ?? 0) + 1;
          if (!Number.isSafeInteger(epoch)) throw new Error('transaction epoch exhausted');
          entry.epoch = epoch; entry.status = 'uncertain'; entry.receipt.status = 'uncertain';
          return { epoch, receipt: structuredClone(entry.receipt) };
        });
        return await callback(takeover.receipt, receipt => journal.write(receipt, takeover.epoch));
      } finally {
        const owned = fstatSync(fd); closeSync(fd);
        const current = lstatSync(recoveryLock);
        if (current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('recovery lock changed');
        unlinkSync(recoveryLock); syncRoot();
      }
    }
  };
}
