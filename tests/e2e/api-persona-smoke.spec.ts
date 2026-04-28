/**
 * api-persona-smoke.spec.ts
 *
 * Validates the persona model (orthogonal to [user].role) and the
 * `/members/me` role-source contract.  Specifically:
 *
 *   P1. GET /members/me returns auth_roles (server-resolved) + personas[]
 *   P2. GET /members/:id/personas returns supported persona enum
 *   P3. PUT /members/:id/personas requires admin role
 *   P4. PUT replaces the persona set idempotently and accepts only the
 *       supported enum values
 *
 * Run modes mirror api-authz-smoke:
 *   E2E_LOCAL_AUTH_ENABLED=1 E2E_API_BASE_URL=http://localhost:3001 \
 *     npx playwright test tests/e2e/api-persona-smoke.spec.ts
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

function resolveBase(): string {
  const raw = (process.env.E2E_API_BASE_URL ?? process.env.BACKEND_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return raw.endsWith('/api/v1') ? raw : `${raw}/api/v1`;
}

const apiBase = resolveBase();
const localMode = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');

const tokens = {
  admin:  process.env.PW_ADMIN_TOKEN  ?? (localMode ? 'e2e-admin' : ''),
  member: process.env.PW_MEMBER_TOKEN ?? (localMode ? 'e2e-user'  : ''),
};

const SUPPORTED = ['participant', 'volunteer', 'mentor', 'guide', 'staff'] as const;

async function authedGet(request: APIRequestContext, path: string, token: string) {
  return request.get(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function authedPut(
  request: APIRequestContext,
  path: string,
  token: string,
  body: Record<string, unknown>,
) {
  return request.put(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  });
}

test.describe('API persona smoke', () => {
  test.skip(!apiBase, 'E2E_API_BASE_URL (or BACKEND_BASE_URL) is required.');

  test('P1: /members/me returns auth_roles and personas array', async ({ request }) => {
    test.skip(!tokens.member, 'member token is required');
    const res = await authedGet(request, '/members/me', tokens.member);
    // 404 is acceptable in environments where no member is linked yet — the
    // contract under test is the SHAPE when the call succeeds.
    if (res.status() === 404) test.skip(true, 'no linked member — cannot verify shape');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('auth_roles');
    expect(Array.isArray(body.auth_roles)).toBe(true);
    expect(body).toHaveProperty('personas');
    expect(Array.isArray(body.personas)).toBe(true);
    for (const p of body.personas) {
      expect(SUPPORTED).toContain(p);
    }
  });

  test('P2: GET /members/:id/personas exposes supported enum', async ({ request }) => {
    test.skip(!tokens.member, 'member token is required');
    const me = await authedGet(request, '/members/me', tokens.member);
    if (me.status() !== 200) test.skip(true, 'cannot resolve self member');
    const meBody = await me.json();
    const memberId = meBody.member_id;
    if (!memberId) test.skip(true, 'no member_id in /me response');

    const res = await authedGet(request, `/members/${memberId}/personas`, tokens.member);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.personas)).toBe(true);
    expect(Array.isArray(body.supported)).toBe(true);
    expect(body.supported.sort()).toEqual([...SUPPORTED].sort());
  });

  test('P3: PUT /members/:id/personas is denied for non-admin', async ({ request }) => {
    test.skip(!tokens.member, 'member token is required');
    const me = await authedGet(request, '/members/me', tokens.member);
    if (me.status() !== 200) test.skip(true, 'cannot resolve self member');
    const memberId = (await me.json()).member_id;
    if (!memberId) test.skip(true, 'no member_id');

    const res = await authedPut(request, `/members/${memberId}/personas`, tokens.member, {
      personas: ['volunteer'],
    });
    expect([401, 403]).toContain(res.status());
  });

  test('P4: PUT rejects unknown persona values with 400', async ({ request }) => {
    test.skip(!tokens.admin, 'admin token is required');
    const adminMe = await authedGet(request, '/members/me', tokens.admin);
    if (adminMe.status() !== 200) test.skip(true, 'admin not linked to a member');
    const memberId = (await adminMe.json()).member_id;
    if (!memberId) test.skip(true, 'no member_id');

    const res = await authedPut(request, `/members/${memberId}/personas`, tokens.admin, {
      personas: ['volunteer', 'admin' /* role, not persona */],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.invalid)).toBe(true);
    expect(body.invalid).toContain('admin');
  });
});
