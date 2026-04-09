#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function collectTestFiles(dirPath, acc = []) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, acc);
      continue;
    }

    if (entry.isFile() && /\.test\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function hasRunnableTest(content) {
  return /\b(?:it|test)(?:\.only|\.skip|\.each)?\s*\(/.test(content);
}

const target = resolve(process.argv[2] ?? 'backend/src/__tests__');
const files = collectTestFiles(target);
const emptySuites = [];

for (const file of files) {
  const stat = statSync(file);
  if (stat.size === 0) {
    emptySuites.push(file);
    continue;
  }

  const content = readFileSync(file, 'utf8');
  if (!hasRunnableTest(content)) {
    emptySuites.push(file);
  }
}

if (emptySuites.length > 0) {
  console.error('[ci] Empty test suite(s) detected. Each *.test.* file must include at least one test()/it() block.');
  for (const suitePath of emptySuites) {
    console.error(` - ${suitePath}`);
  }
  process.exit(1);
}

console.log(`[ci] Test suite sanity check passed (${files.length} files scanned).`);
