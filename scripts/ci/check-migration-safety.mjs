#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const candidates = [
  path.join(repoRoot, 'scripts'),
  path.join(repoRoot, 'database'),
].filter((dir) => fs.existsSync(dir));

const sqlFiles = [];
for (const dir of candidates) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.sql')) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!lower.includes('migrate') && !lower.includes('migration') && !lower.includes('schema')) {
      continue;
    }
    sqlFiles.push(path.join(dir, entry.name));
  }
}

const safetyRegexes = [
  { label: 'DROP_TABLE', regex: /\bdrop\s+table\b/i, hint: 'Use expand/contract. Do not drop tables in same release as code changes.' },
  { label: 'DROP_COLUMN', regex: /\balter\s+table\b[\s\S]{0,300}?\bdrop\s+column\b/i, hint: 'Column drops must be deferred to a later contract phase.' },
  { label: 'RENAME_COLUMN', regex: /\bsp_rename\b[\s\S]{0,300}?\bcolumn\b/i, hint: 'Prefer additive columns + backfill; avoid in-place rename.' },
  { label: 'NARROWING_ALTER', regex: /\balter\s+table\b[\s\S]{0,500}?\balter\s+column\b[\s\S]{0,120}?\b(not\s+null|nvarchar\([0-9]{1,3}\)|varchar\([0-9]{1,3}\))\b/i, hint: 'Potentially breaking alter detected. Confirm backward compatibility.' },
];

function hasAllowOverride(content, label) {
  const pattern = new RegExp(`--\\s*allow-breaking-migration\\s*:\\s*${label}`, 'i');
  return pattern.test(content);
}

const findings = [];
for (const file of sqlFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const check of safetyRegexes) {
    if (!check.regex.test(content)) {
      continue;
    }
    if (hasAllowOverride(content, check.label)) {
      continue;
    }
    findings.push({ file, check: check.label, hint: check.hint });
  }

  const deleteStatements = content.match(/\bdelete\s+from\b[\s\S]*?(?:;|$)/gi) ?? [];
  for (const statement of deleteStatements) {
    if (/\bwhere\b/i.test(statement)) {
      continue;
    }
    if (hasAllowOverride(content, 'UNSCOPED_DELETE')) {
      continue;
    }
    findings.push({
      file,
      check: 'UNSCOPED_DELETE',
      hint: 'Unscoped deletes are risky. Require WHERE clause and idempotent guards.',
    });
    break;
  }
}

if (findings.length > 0) {
  console.error('[migration-safety] FAILED: potential breaking SQL migration patterns detected.');
  for (const finding of findings) {
    const rel = path.relative(repoRoot, finding.file);
    console.error(`- ${rel} :: ${finding.check} :: ${finding.hint}`);
  }
  console.error('[migration-safety] If a change is intentional, add an explicit allow comment in that SQL file:');
  console.error('  -- allow-breaking-migration: <CHECK_LABEL>');
  process.exit(1);
}

console.log('[migration-safety] OK: no unsafe migration patterns detected.');
