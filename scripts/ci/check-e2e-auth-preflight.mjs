#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function parseArgs(argv) {
  const parsed = {
    mode: 'env',
    statePath: 'tests/e2e/.auth/member.json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      parsed.mode = argv[index + 1] || parsed.mode;
      index += 1;
      continue;
    }
    if (arg === '--state-path') {
      parsed.statePath = argv[index + 1] || parsed.statePath;
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      parsed.mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg.startsWith('--state-path=')) {
      parsed.statePath = arg.slice('--state-path='.length);
      continue;
    }
  }

  return parsed;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    return null;
  }

  try {
    const encoded = token.split('.')[1] || '';
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeApiBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    return '';
  }

  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

function normalizeMachineScope(rawScope, clientId) {
  const trimmed = String(rawScope || '').trim();
  if (!trimmed) {
    return '';
  }

  if (/\/\.default$/i.test(trimmed)) {
    return trimmed;
  }

  if (/\/access_as_user$/i.test(trimmed)) {
    return trimmed.replace(/\/access_as_user$/i, '/.default');
  }

  if (/^api:\/\/[0-9a-f-]+$/i.test(trimmed)) {
    return `${trimmed}/.default`;
  }

  if (/^[0-9a-f-]{36}$/i.test(trimmed)) {
    return `api://${trimmed}/.default`;
  }

  if (/^api:\/\/[0-9a-f-]+\/[0-9a-z_\-.]+$/i.test(trimmed)) {
    const appId = trimmed.split('/')[2];
    return `api://${appId}/.default`;
  }

  if (clientId && /^https?:\/\//i.test(trimmed)) {
    return `${trimmed}/.default`;
  }

  return trimmed;
}

function collectErrorsForEnvPreflight() {
  const errors = [];
  const appUrl = String(process.env.E2E_APP_URL || '').trim();
  const apiBaseRaw = String(process.env.E2E_API_BASE_URL || '').trim();
  const apiBase = normalizeApiBaseUrl(apiBaseRaw);
  const authorityHost = String(process.env.AZURE_AUTHORITY_HOST || 'b2clogin.com').trim();
  const requireRopc = isEnabled(process.env.E2E_REQUIRE_ROPC);
  const validateVariantA = isEnabled(process.env.E2E_VALIDATE_VARIANT_A) || isEnabled(process.env.E2E_AUTH_VARIANT_A_ENABLED);

  if (!appUrl) {
    errors.push('Missing E2E_APP_URL.');
  }

  if (!apiBaseRaw) {
    errors.push('Missing E2E_API_BASE_URL.');
  }

  const rolePairs = [
    ['PW_ADMIN_USER', 'PW_ADMIN_PASS'],
    ['PW_EVENT_CREATOR_USER', 'PW_EVENT_CREATOR_PASS'],
    ['PW_MEMBER_USER', 'PW_MEMBER_PASS'],
  ];

  for (const [userKey, passKey] of rolePairs) {
    const user = String(process.env[userKey] || '').trim();
    const pass = String(process.env[passKey] || '').trim();
    if (!user || !pass) {
      errors.push(`Missing role credentials: ${userKey}/${passKey}.`);
    }
  }

  if (requireRopc) {
    const tenantName = String(process.env.AZURE_EXTERNAL_TENANT_NAME || '').trim();
    const tenantId = String(process.env.AZURE_EXTERNAL_TENANT_ID || '').trim();
    const clientId = String(process.env.AZURE_CLIENT_ID || '').trim();
    const ropcPolicy = String(process.env.AZURE_B2C_ROPC_POLICY || '').trim();
    const ropcScope = String(process.env.VITE_API_SCOPE || process.env.AZURE_API_SCOPE || '').trim();

    if (!tenantName) {
      errors.push('Missing AZURE_EXTERNAL_TENANT_NAME (required for ROPC).');
    }

    if (!clientId) {
      errors.push('Missing AZURE_CLIENT_ID (required for ROPC).');
    }

    if (!ropcScope) {
      errors.push('Missing VITE_API_SCOPE or AZURE_API_SCOPE (required for ROPC token acquisition).');
    }

    if (authorityHost.includes('ciamlogin')) {
      if (!tenantId) {
        errors.push('Missing AZURE_EXTERNAL_TENANT_ID for CIAM authority ROPC flow.');
      }
    } else if (!ropcPolicy) {
      errors.push('Missing AZURE_B2C_ROPC_POLICY for B2C authority ROPC flow.');
    }
  }

  if (validateVariantA) {
    const m2mTenantId = String(process.env.E2E_AUTH_M2M_TENANT_ID || '').trim();
    const m2mClientId = String(process.env.E2E_AUTH_M2M_CLIENT_ID || '').trim();
    const m2mClientSecret = String(process.env.E2E_AUTH_M2M_CLIENT_SECRET || '').trim();
    const m2mScope = String(process.env.E2E_AUTH_M2M_SCOPE || '').trim();
    const normalizedM2mScope = normalizeMachineScope(m2mScope, m2mClientId);
    const exchangeUrl = String(process.env.E2E_AUTH_EXCHANGE_URL || '').trim() || (apiBase ? `${apiBase}/auth/e2e/exchange` : '');

    if (!m2mTenantId) {
      errors.push('Missing E2E_AUTH_M2M_TENANT_ID for Variant A.');
    }

    if (!m2mClientId) {
      errors.push('Missing E2E_AUTH_M2M_CLIENT_ID for Variant A.');
    }

    if (!m2mClientSecret) {
      errors.push('Missing E2E_AUTH_M2M_CLIENT_SECRET for Variant A.');
    }

    if (!m2mScope) {
      errors.push('Missing E2E_AUTH_M2M_SCOPE for Variant A machine token.');
    } else if (!/\/\.default$/i.test(normalizedM2mScope)) {
      errors.push(`Invalid E2E_AUTH_M2M_SCOPE "${m2mScope}". Client-credentials scope must resolve to a "/.default" scope.`);
    }

    if (!exchangeUrl) {
      errors.push('Missing Variant A exchange URL. Set E2E_AUTH_EXCHANGE_URL or E2E_API_BASE_URL.');
    } else {
      try {
        new URL(exchangeUrl);
      } catch {
        errors.push(`Invalid Variant A exchange URL: ${exchangeUrl}`);
      }
    }
  }

  return errors;
}

function collectIdTokenEmailsFromState(storageState) {
  const results = [];
  const origins = Array.isArray(storageState?.origins) ? storageState.origins : [];

  for (const origin of origins) {
    const localStorage = Array.isArray(origin?.localStorage) ? origin.localStorage : [];
    for (const entry of localStorage) {
      const key = String(entry?.name || '').toLowerCase();
      const value = String(entry?.value || '');

      if (!key.includes('idtoken')) {
        continue;
      }

      let token = '';
      try {
        const parsed = JSON.parse(value);
        token = typeof parsed?.secret === 'string' ? parsed.secret : '';
      } catch {
        token = value;
      }

      const claims = decodeJwtPayload(token);
      const email = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';
      if (email && email.includes('@')) {
        results.push(email);
      }
    }
  }

  return Array.from(new Set(results));
}

function collectExternalE2EEmailsFromState(storageState) {
  const results = [];
  const origins = Array.isArray(storageState?.origins) ? storageState.origins : [];

  for (const origin of origins) {
    const localStorage = Array.isArray(origin?.localStorage) ? origin.localStorage : [];
    const externalAuthEnabled = localStorage.some((entry) => entry?.name === 'phw_e2e_external_auth' && String(entry?.value || '') === '1');
    if (!externalAuthEnabled) {
      continue;
    }

    for (const entry of localStorage) {
      if (entry?.name !== 'phw_e2e_external_email') {
        continue;
      }

      const email = String(entry?.value || '').trim().toLowerCase();
      if (email && email.includes('@')) {
        results.push(email);
      }
    }
  }

  return Array.from(new Set(results));
}

function collectErrorsForAuthStatePreflight(statePathValue) {
  const errors = [];
  const statePath = path.resolve(process.cwd(), statePathValue);

  if (!fs.existsSync(statePath)) {
    errors.push(`Missing auth state file: ${statePath}`);
    return errors;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    errors.push(`Invalid JSON auth state file (${statePath}): ${reason}`);
    return errors;
  }

  const emails = [
    ...collectIdTokenEmailsFromState(parsed),
    ...collectExternalE2EEmailsFromState(parsed),
  ];
  if (emails.length === 0) {
    errors.push(`Auth state file ${statePath} does not contain an id_token email claim or external E2E email seed. browser-auth-email-hint will fail.`);
  }

  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let errors = [];

  if (args.mode === 'env') {
    errors = collectErrorsForEnvPreflight();
  } else if (args.mode === 'auth-state') {
    errors = collectErrorsForAuthStatePreflight(args.statePath);
  } else {
    console.error(`[auth-preflight] Unknown mode: ${args.mode}`);
    process.exit(1);
  }

  if (errors.length > 0) {
    console.error('[auth-preflight] failed with the following issues:');
    for (const error of errors) {
      console.error(` - ${error}`);
    }
    process.exit(1);
  }

  console.log(`[auth-preflight] ${args.mode} checks passed.`);
}

main();
