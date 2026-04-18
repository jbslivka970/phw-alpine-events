import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type MemberSummary = {
  member_id: string;
  email: string | null;
};

type MemberGroup = {
  group_name?: string | null;
};

type DeliveryLogRow = {
  member_id: string | null;
  operation_type: string | null;
  template_id: string | null;
};

type DeliveryLogPayload = {
  rows: DeliveryLogRow[];
};

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
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const adminToken = process.env.PW_ADMIN_TOKEN ?? (localE2EAuthEnabled ? 'e2e-admin' : '');

async function apiCall(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  token: string,
  data?: Record<string, unknown>
): Promise<APIResponse> {
  const url = `${apiBaseUrl}${path}`;
  const options = {
    headers: { Authorization: `Bearer ${token}` },
    data,
  };

  if (method === 'GET') {
    return request.get(url, { headers: options.headers });
  }
  if (method === 'PUT') {
    return request.put(url, options);
  }
  return request.post(url, options);
}

async function fetchJson<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  token: string,
  data?: Record<string, unknown>
): Promise<{ status: number; body: T }> {
  const response = await apiCall(request, method, path, token, data);
  const status = response.status();
  let body: T;

  try {
    body = (await response.json()) as T;
  } catch {
    body = {} as T;
  }

  return { status, body };
}

async function findMembersForParticipantFlow(
  request: APIRequestContext,
  token: string,
  neededCount: number
): Promise<MemberSummary[]> {
  const listResult = await fetchJson<{ rows?: MemberSummary[] }>(
    request,
    'GET',
    '/members?page=1&pageSize=200&isActive=true',
    token
  );

  expect(listResult.status).toBe(200);

  const candidates = (listResult.body.rows ?? []).filter((member) => Boolean(member.member_id));
  const picked: MemberSummary[] = [];

  for (const candidate of candidates) {
    const groupsResult = await fetchJson<MemberGroup[]>(
      request,
      'GET',
      `/members/${candidate.member_id}/groups`,
      token
    );

    if (groupsResult.status !== 200) {
      continue;
    }

    const hasParticipantGroup = groupsResult.body.some((group) =>
      String(group.group_name ?? '').toUpperCase().includes('PARTICIPANT')
    );

    if (!hasParticipantGroup) {
      continue;
    }

    picked.push(candidate);
    if (picked.length >= neededCount) {
      break;
    }
  }

  return picked;
}

async function pollDeliveryLogs(
  request: APIRequestContext,
  token: string,
  eventId: string,
  operationType: string,
  predicate: (row: DeliveryLogRow) => boolean,
  timeoutMs = 60_000
): Promise<DeliveryLogRow | null> {
  const start = Date.now();
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  while (Date.now() - start < timeoutMs) {
    const response = await fetchJson<DeliveryLogPayload>(
      request,
      'GET',
      `/reports/delivery/logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&event_id=${eventId}&operation_type=${operationType}&page=1&page_size=100`,
      token
    );

    if (response.status === 200) {
      const match = (response.body.rows ?? []).find(predicate);
      if (match) {
        return match;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return null;
}

test.describe('API notification lifecycle e2e', () => {
  test.skip(!apiBaseUrl, 'E2E_API_BASE_URL is required.');
  test.skip(!adminToken, 'PW_ADMIN_TOKEN is required for notification lifecycle validation.');
  test.setTimeout(180_000);

  test('covers RSVP received, assignment confirmation variants, and assignment-based waitlist notification', async ({ request }) => {
    const members = await findMembersForParticipantFlow(request, adminToken, 3);
    test.skip(members.length < 3, 'Need at least 3 active PARTICIPANT members for this lifecycle test.');

    const [memberRsvpAssigned, memberAdminAdded, memberWaitlisted] = members;

    const eventCreate = await fetchJson<{ event_id: string }>(
      request,
      'POST',
      '/events',
      adminToken,
      {
        title: `E2E Notification Lifecycle ${randomUUID().slice(0, 8)}`,
        description: 'E2E validation for notification lifecycle',
        location: 'E2E Test Location',
        event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        participant_capacity: 1,
        mentor_capacity: 0,
      }
    );

    expect(eventCreate.status).toBe(201);
    const eventId = eventCreate.body.event_id;
    expect(eventId).toBeTruthy();

    const publishEvent = await fetchJson<Record<string, unknown>>(
      request,
      'PUT',
      `/events/${eventId}/status`,
      adminToken,
      { status: 'published' }
    );
    expect(publishEvent.status).toBe(200);

    const firstRsvp = await fetchJson<{ response: string }>(
      request,
      'POST',
      `/events/${eventId}/rsvp`,
      adminToken,
      {
        member_id: memberRsvpAssigned.member_id,
        response: 'yes',
        response_role: 'PARTICIPANT',
      }
    );
    expect(firstRsvp.status).toBe(200);
    expect(firstRsvp.body.response).toBe('yes');

    const rsvpReceivedLog = await pollDeliveryLogs(
      request,
      adminToken,
      eventId,
      'rsvp_confirmation',
      (row) => row.member_id === memberRsvpAssigned.member_id
    );
    expect(rsvpReceivedLog).not.toBeNull();
    expect(rsvpReceivedLog?.template_id).toBe('rsvp-confirmation');

    const assignFromRsvp = await fetchJson<Record<string, unknown>>(
      request,
      'POST',
      `/events/${eventId}/assignments`,
      adminToken,
      {
        member_id: memberRsvpAssigned.member_id,
        role: 'PARTICIPANT',
      }
    );
    expect(assignFromRsvp.status).toBe(201);

    const assignmentConfirmedLog = await pollDeliveryLogs(
      request,
      adminToken,
      eventId,
      'assignment_confirmation',
      (row) => row.member_id === memberRsvpAssigned.member_id
    );
    expect(assignmentConfirmedLog).not.toBeNull();
    expect(assignmentConfirmedLog?.template_id).toBe('assignment-confirmation');

    const assignWithoutRsvp = await fetchJson<Record<string, unknown>>(
      request,
      'POST',
      `/events/${eventId}/assignments`,
      adminToken,
      {
        member_id: memberAdminAdded.member_id,
        role: 'PARTICIPANT',
      }
    );
    expect(assignWithoutRsvp.status).toBe(201);

    const adminAddedLog = await pollDeliveryLogs(
      request,
      adminToken,
      eventId,
      'assignment_confirmation',
      (row) => row.member_id === memberAdminAdded.member_id
    );
    expect(adminAddedLog).not.toBeNull();
    expect(adminAddedLog?.template_id).toBe('assignment-admin-added');

    const overflowRsvp = await fetchJson<{ response: string }>(
      request,
      'POST',
      `/events/${eventId}/rsvp`,
      adminToken,
      {
        member_id: memberWaitlisted.member_id,
        response: 'yes',
        response_role: 'PARTICIPANT',
      }
    );
    expect(overflowRsvp.status).toBe(200);
    expect(overflowRsvp.body.response).toBe('waitlist');

    const waitlistedLog = await pollDeliveryLogs(
      request,
      adminToken,
      eventId,
      'rsvp_waitlisted',
      (row) => row.member_id === memberWaitlisted.member_id
    );
    expect(waitlistedLog).not.toBeNull();
    expect(waitlistedLog?.template_id).toBe('rsvp-waitlisted');
  });
});
