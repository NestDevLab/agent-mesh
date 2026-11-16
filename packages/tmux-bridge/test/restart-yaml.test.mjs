import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const parser = fileURLToPath(new URL('../bin/restart-yaml.py', import.meta.url));
const parse = text => spawnSync('python3', ['-I', parser], { input: text, encoding: 'utf8' });
test('restart YAML accepts a single fenced block and standalone documents', () => {
  assert.deepEqual(JSON.parse(parse('schema: example\nskills: [one, two]\n').stdout), { schema: 'example', skills: ['one', 'two'] });
  const result = parse('# State\n\n## RIAVVIO\n\n```yaml\nschema: example\n```\n\n## Notes\nhello\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { schema: 'example' });
});
test('restart YAML rejects ambiguous or unsafe inputs without exposing contents', () => {
  for (const input of ['key: first\nkey: second\n', 'key: &anchor first\nother: *anchor\n', 'key: !!str value\n', 'a: 1\n---\na: 2\n', '## RIAVVIO\nnot a block\n', '## RIAVVIO\n```yaml\na: 1\n```\n## RIAVVIO\n```yaml\na: 2\n```\n', 'secret: fixture\n'.repeat(80000)]) {
    const result = parse(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('fixture'));
  }
});
