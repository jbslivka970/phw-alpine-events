import { expect, test, type APIRequestContext } from '@playwright/test';

function resolveApiBase(): string {
  const raw = (process.env.E2E_API_BASE_URL ?? process.env.BACKEND_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (!raw) {
    return '';
  }

  return raw.endsWith('/api/v1') ? raw : `${raw}/api/v1`;
}

const apiBase = resolveApiBase();
const denyTenantId = (process.env.E2E_DENY_TENANT_ID ?? '00000000-0000-4000-8000-000000000999').trim();

const tokens = {
  admin: process.env.PW_ADMIN_TOKEN ?? '',
  eventCreator: process.env.PW_EVENT_CREATOR_TOKEN ?? '',
  member: process.env.PW_MEMBER_TOKEN ?? '',
};

async function get(
  request: APIRequestContext,
  path: string,
  token: string,
  extra?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await request.get(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(extra ?? {}),
    },
  });

  return {
    status: response.status(),
    body: await response.text(),
  };
}

test.describe('API tenant denial matrix', () => {
  test.skip(!apiBase, 'E2E_API_BASE_URL (or BACKEND_BASE_URL) is required.');

  for (const [label, token] of Object.entries(tokens)) {
    test(`handles inaccessible tenant header for ${label}`, async ({ request }) => {
      test.skip(!token, `${label} token is required.`);

      const baseline = await get(request, '/events', token);
      expect(baseline.status, `${label} baseline /events request should stay authenticated`).not.toBe(401);
      expect(baseline.status, `${label} baseline /events request should not fail authorization`).not.toBe(403);
      expect(baseline.status, `${label} baseline /events request should not error`).not.toBe(500);

      const denied = await get(request, '/events', token, {
        'X-Tenant-Id': denyTenantId,
      });

      if (label === 'admin') {
        expect(denied.status, `${label} should retain root-scoped access when forcing an inaccessible tenant header`).toBe(200);
        return;
      }

      expect(denied.status, `${label} should be denied when forcing an inaccessible tenant header`).toBe(403);
      expect(denied.body, `${label} denial body should explain tenant access failure`).toContain('Requested tenant is not accessible');
    });
  }
});