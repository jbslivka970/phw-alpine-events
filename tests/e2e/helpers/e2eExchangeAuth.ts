import type { Page } from '@playwright/test';

type PersonaLabel = 'admin' | 'event_creator' | 'member';

type ExchangeResponse = {
  access_token: string;
  email?: string;
  member_id?: string;
  roles?: string[];
};

let cachedMachineToken: { token: string; expiresAtMs: number } | null = null;

function variantAEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.E2E_AUTH_VARIANT_A_ENABLED ?? '');
}

function parseApiBaseUrl(): string {
  const raw = (process.env.E2E_API_BASE_URL ?? process.env.BACKEND_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (!raw) {
    return '';
  }

  return raw.endsWith('/api/v1') ? raw : `${raw}/api/v1`;
}

function resolveExchangeUrl(): string {
  const explicit = (process.env.E2E_AUTH_EXCHANGE_URL ?? '').trim();
  if (explicit) {
    return explicit;
  }

  const apiBase = parseApiBaseUrl();
  return apiBase ? `${apiBase}/auth/e2e/exchange` : '';
}

function resolveMachineTokenUrl(): string {
  const explicit = (process.env.E2E_AUTH_M2M_TOKEN_URL ?? '').trim();
  if (explicit) {
    return explicit;
  }

  const tenantId = (process.env.E2E_AUTH_M2M_TENANT_ID ?? '').trim();
  if (!tenantId) {
    return '';
  }

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

function normalizeMachineScope(rawScope: string, clientId: string): string {
  const trimmed = rawScope.trim();
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

function resolveRole(roles: string[] | undefined, fallback: PersonaLabel): string {
  const normalized = (roles ?? []).map((value) => value.trim().toUpperCase());
  if (normalized.includes('ADMIN')) {
    return 'ADMIN';
  }
  if (normalized.includes('EVENT_CREATOR')) {
    return 'EVENT_CREATOR';
  }
  if (normalized.includes('TAVF_CREATOR')) {
    return 'TAVF_CREATOR';
  }

  if (fallback === 'admin') {
    return 'ADMIN';
  }
  if (fallback === 'event_creator') {
    return 'EVENT_CREATOR';
  }
  return 'USER';
}

async function acquireMachineToken(): Promise<string> {
  const now = Date.now();
  if (cachedMachineToken && cachedMachineToken.expiresAtMs - now > 60_000) {
    return cachedMachineToken.token;
  }

  const tokenUrl = resolveMachineTokenUrl();
  const clientId = (process.env.E2E_AUTH_M2M_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.E2E_AUTH_M2M_CLIENT_SECRET ?? '').trim();
  const requestedScope = (process.env.E2E_AUTH_M2M_SCOPE ?? '').trim();
  const scope = normalizeMachineScope(requestedScope, clientId);

  if (!tokenUrl || !clientId || !clientSecret || !scope) {
    throw new Error('Variant A machine-token env is incomplete (token URL/client ID/client secret/scope).');
  }

  if (!/\/\.default$/i.test(scope)) {
    throw new Error(`Variant A machine-token scope must end with '/.default'. Received: ${requestedScope}`);
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Variant A machine-token request failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error('Variant A machine-token response missing access_token.');
  }

  const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600;
  cachedMachineToken = {
    token: payload.access_token,
    expiresAtMs: now + Math.max(60, expiresIn) * 1000,
  };

  return payload.access_token;
}

async function exchangePersonaToken(persona: PersonaLabel): Promise<ExchangeResponse> {
  const exchangeUrl = resolveExchangeUrl();
  if (!exchangeUrl) {
    throw new Error('Variant A exchange URL is not configured.');
  }

  const machineToken = await acquireMachineToken();
  const response = await fetch(exchangeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${machineToken}`,
    },
    body: JSON.stringify({ persona }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Variant A exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = (await response.json()) as ExchangeResponse;
  if (!payload.access_token) {
    throw new Error('Variant A exchange response missing access_token.');
  }

  return payload;
}

export async function authenticateWithVariantA(
  page: Page,
  options: { appBaseUrl: string; persona: PersonaLabel }
): Promise<boolean> {
  if (!variantAEnabled()) {
    return false;
  }

  try {
    const exchanged = await exchangePersonaToken(options.persona);
    const role = resolveRole(exchanged.roles, options.persona);

    await page.addInitScript((seed) => {
      window.localStorage.setItem('phw_e2e_external_auth', '1');
      window.localStorage.setItem('phw_e2e_external_token', seed.token);
      window.localStorage.setItem('phw_e2e_role', seed.role);

      if (seed.email) {
        window.localStorage.setItem('phw_e2e_external_email', seed.email);
      } else {
        window.localStorage.removeItem('phw_e2e_external_email');
      }

      if (seed.userId) {
        window.localStorage.setItem('phw_e2e_external_user_id', seed.userId);
      } else {
        window.localStorage.removeItem('phw_e2e_external_user_id');
      }
    }, {
      token: exchanged.access_token,
      role,
      email: exchanged.email ?? '',
      userId: exchanged.member_id ?? '',
    });

    await page.goto(`${options.appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_200);
    return !/\/login(\?|$)/i.test(page.url());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[variant-a-auth] ${options.persona} failed: ${message}`);
    return false;
  }
}

export function clearVariantASeed(page: Page): Promise<void> {
  return page.addInitScript(() => {
    window.localStorage.removeItem('phw_e2e_external_auth');
    window.localStorage.removeItem('phw_e2e_external_token');
    window.localStorage.removeItem('phw_e2e_external_email');
    window.localStorage.removeItem('phw_e2e_external_user_id');
  });
}
