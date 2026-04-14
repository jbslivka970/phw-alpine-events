#!/usr/bin/env node

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isEnabled(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return TRUTHY.has(value.trim().toLowerCase());
}

const checks = [
  {
    name: 'E2E_LOCAL_AUTH_ENABLED',
    value: process.env.E2E_LOCAL_AUTH_ENABLED,
    reason: 'Backend local auth bypass must never be enabled in CI/deploy contexts.',
  },
  {
    name: 'VITE_E2E_LOCAL_AUTH',
    value: process.env.VITE_E2E_LOCAL_AUTH,
    reason: 'Frontend local auth bypass must never be enabled in CI/deploy contexts.',
  },
];

const failures = checks.filter((entry) => isEnabled(entry.value));

if (failures.length > 0) {
  console.error('[deploy-safety] FAILED: unsafe local bypass flags detected.');
  for (const failure of failures) {
    console.error(`- ${failure.name}=${failure.value} :: ${failure.reason}`);
  }
  process.exit(1);
}

console.log('[deploy-safety] OK: no local bypass flags enabled.');
