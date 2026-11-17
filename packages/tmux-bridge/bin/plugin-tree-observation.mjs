/** Read-only bounded observation of a plugin directory; not an immutable seal. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const MAX_ENTRIES = 10000;
const MAX_BYTES = 64 * 1024 * 1024;
const stamp = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const hash = value => createHash('sha256').update(value).digest('hex');

// Reject symlinks and special files rather than follow them outside the tree.
// The digest detects changes at observation boundaries; it cannot prevent a
// writer from changing the tree afterward or prove the author is trusted.
export async function observePluginTree(root) {
  const records = [], budget = { entries: 0, bytes: 0 };
  async function visit(path, relative, depth) {
    if (++budget.entries > MAX_ENTRIES || depth > 128) throw new Error('plugin tree exceeds limits');
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink()) throw new Error('plugin tree contains symlink');
    if (before.isDirectory()) {
      const names = await readdir(path);
      if (names.some(item => item.includes('\ufffd'))) throw new Error('plugin tree name is not valid UTF-8');
      names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      records.push(['dir', relative, String(before.mode & 0o777n)]);
      for (const child of names) await visit(join(path, child), relative ? `${relative}/${child}` : child, depth + 1);
      if (stamp(before) !== stamp(await lstat(path, { bigint: true }))) throw new Error('plugin directory changed during observation');
      return;
    }
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES) || budget.bytes + Number(before.size) > MAX_BYTES) throw new Error('unsupported plugin file');
    budget.bytes += Number(before.size);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat({ bigint: true });
      if (stamp(opened) !== stamp(before)) throw new Error('plugin file changed during observation');
      const data = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw new Error('plugin file truncated during observation');
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (data.length !== Number(before.size) || stamp(after) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) throw new Error('plugin file changed during observation');
      records.push(['file', relative, String(before.mode & 0o777n), String(before.size), hash(data)]);
    } finally { await file.close(); }
  }
  await visit(root, '', 0);
  return { sha256: hash(JSON.stringify(records)), entries: budget.entries, bytes: budget.bytes };
}
