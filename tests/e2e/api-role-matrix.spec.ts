import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

function resolveApiBaseUrl(): string {
  const rawBase = process.env.E2E_API_BASE_URL ?? process.env.BACKEND_BASE_URL ?? '';
  const trimmed = rawBase.trim().replace(/\/$/, '');

  if (!trimmed) {
    return '';
  }

  if (trimmed.endsWith('/api/v1')) {
    return trimmed;
  }

  return `${trimmed}/api/v1`;
}

const apiBaseUrl = resolveApiBaseUrl();
const eventCreatorToken = process.env.PW_EVENT_CREATOR_TOKEN ?? '';
const memberToken = process.env.PW_MEMBER_TOKEN ?? '';

test.describe('API role-path matrix', () => {
  test.skip(!apiBaseUrl, 'E2E_API_BASE_URL (or BACKEND_BASE_URL) is required.');

  test('events status endpoint allows authenticated callers through authz gate', async ({ request }) => {
    test.skip(!eventCreatorToken, 'PW_EVENT_CREATOR_TOKEN is required for this assertion.');

    const eventId = randomUUID();
    const response = await request.put(`${apiBaseUrl}/events/${eventId}/status`, {
      headers: {
        Authorization: `Bearer ${eventCreatorToken}`,
      },
      data: {
        status: 'cancelled',
      },
    });

    expect(response.status(), 'authenticated event creator should not be blocked by RBAC').not.toBe(401);
    expect(response.status(), 'authenticated event creator should not be blocked by RBAC').not.toBe(403);
  });

  test('events status endpoint also allows non-creator authenticated callers through authz gate', async ({ request }) => {
    test.skip(!memberToken, 'PW_MEMBER_TOKEN is required for this assertion.');

    const eventId = randomUUID();
    const response = await request.put(`${apiBaseUrl}/events/${eventId}/status`, {
      headers: {
        Authorization: `Bearer ${memberToken}`,
      },
      data: {
        status: 'cancelled',
      },
    });

    expect(response.status(), 'authenticated member should not be blocked by RBAC').not.toBe(401);
    expect(response.status(), 'authenticated member should not be blocked by RBAC').not.toBe(403);
  });

  test('tavf create accepts legacy non-UUID guide ids without UUID-validation failure', async ({ request }) => {
    test.skip(!eventCreatorToken, 'PW_EVENT_CREATOR_TOKEN is required for this assertion.');

    const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await request.post(`${apiBaseUrl}/tavf/postings`, {
      headers: {
        Authorization: `Bearer ${eventCreatorToken}`,
      },
      data: {
        guide_member_id: 'legacy-auth-subject',
        event_date: eventDate,
        location: 'Playwright Smoke River',
        capacity: 1,
        species: 'Trout',
      },
    });

    expect(response.status(), 'TAVF create should not crash').not.toBe(500);
    expect(response.status(), 'authenticated caller should not be blocked').not.toBe(401);
    expect(response.status(), 'authenticated caller should not be blocked').not.toBe(403);

    if (response.status() === 400) {
      const body = await response.json() as { error?: string };
      expect((body.error ?? '').toLowerCase()).not.toContain('guide_member_id must be a valid uuid');
    }
  });
});
