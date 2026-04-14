#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const mustExist = [
  'frontend/public/privacy.html',
  'frontend/public/terms.html',
  'frontend/public/sms-program.html',
  'frontend/public/consent.html',
  'frontend/public/sms-messaging.html',
  'frontend/public/compliance/sms-consent-artifact.svg',
  'frontend/public/compliance/sms-consent-artifact.html',
  'frontend/public/web.config',
];

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

function readText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`);
    return null;
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

for (const relativePath of mustExist) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing required file: ${relativePath}`);
  }
}

const webConfig = readText('frontend/public/web.config');
if (webConfig) {
  const rewriteChecks = [
    '^privacy/?$',
    '^terms/?$',
    '^consent/?$',
    '^sms-program/?$',
    '^sms-messaging/?$',
  ];

  for (const rulePattern of rewriteChecks) {
    if (!webConfig.includes(rulePattern)) {
      fail(`web.config missing rewrite pattern: ${rulePattern}`);
    }
  }
}

const smsProgram = readText('frontend/public/sms-program.html');
if (smsProgram) {
  if (!smsProgram.includes('/compliance/sms-consent-artifact.svg')) {
    fail('sms-program.html must link to /compliance/sms-consent-artifact.svg');
  }
  if (!smsProgram.includes('/compliance/sms-consent-artifact.html')) {
    fail('sms-program.html must link to /compliance/sms-consent-artifact.html');
  }
  if (!smsProgram.includes('<img') || !smsProgram.includes('src="/compliance/sms-consent-artifact.svg"')) {
    fail('sms-program.html must embed the SVG consent artifact image');
  }
}

const consent = readText('frontend/public/consent.html');
if (consent) {
  if (!consent.includes('/compliance/sms-consent-artifact.svg')) {
    fail('consent.html must link to /compliance/sms-consent-artifact.svg');
  }
  if (!consent.includes('/sms-program')) {
    fail('consent.html must link to /sms-program');
  }
}

const legalPages = [
  'frontend/public/privacy.html',
  'frontend/public/terms.html',
  'frontend/public/sms-program.html',
  'frontend/public/consent.html',
];

for (const pagePath of legalPages) {
  const content = readText(pagePath);
  if (!content) {
    continue;
  }
  if (content.includes('<script')) {
    fail(`${pagePath} should not include script tags (must render without JS)`);
  }
}

if (failures > 0) {
  console.error(`\nCompliance static checks failed: ${failures}`);
  process.exit(1);
}

console.log('Compliance static checks passed.');
