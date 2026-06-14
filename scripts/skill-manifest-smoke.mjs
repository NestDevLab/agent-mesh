#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, 'skills');
const requiredMismatches = new Map([
  ['agent-tmux', 'agent-tmux-bridge'],
]);

function parseFrontmatter(text, file) {
  if (!text.startsWith('---\n')) {
    throw new Error(`${file}: missing YAML frontmatter`);
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error(`${file}: unterminated YAML frontmatter`);
  }
  const block = text.slice(4, end).split('\n');
  const fields = new Map();
  for (const line of block) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  return fields;
}

const entries = fs.existsSync(skillsRoot)
  ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  : [];

if (entries.length === 0) {
  throw new Error('No skills found under skills/');
}

const seenNames = new Map();
const mismatches = [];

for (const entry of entries) {
  const skillDir = path.join(skillsRoot, entry.name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`${skillDir}: missing SKILL.md`);
  }
  const fields = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'), skillFile);
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name) throw new Error(`${skillFile}: missing frontmatter name`);
  if (!description) throw new Error(`${skillFile}: missing frontmatter description`);
  if (seenNames.has(name)) {
    throw new Error(`${skillFile}: duplicate skill name ${name} also in ${seenNames.get(name)}`);
  }
  seenNames.set(name, skillFile);
  if (name !== entry.name) {
    mismatches.push(`${entry.name}=>${name}`);
    const expected = requiredMismatches.get(entry.name);
    if (expected !== name) {
      throw new Error(
        `${skillFile}: directory/name mismatch ${entry.name}=>${name} is not declared in skill-manifest-smoke.mjs`,
      );
    }
  }
}

for (const [dir, name] of requiredMismatches) {
  if (!seenNames.has(name)) {
    throw new Error(`required skill mapping ${dir}=>${name} not found`);
  }
}

console.log(`SKILL_MANIFEST_OK skills=${entries.length} mismatches=${mismatches.join(',') || 'none'}`);
