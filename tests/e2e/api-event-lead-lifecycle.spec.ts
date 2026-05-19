import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type MemberSummary = {
  member_id: string;
  email: string | null;
};

type MemberGroup = {
  group_name?: string | null;
};

type GroupSummary = {
  group_id: string;
  group_name?: string | null;
};

type AssignmentRow = {
  assignment_id: string;
  member_id: string;
  role: 'LEAD' | 'MENTOR' | 'PARTICIPANT';
  attended: boolean | null;
};

type DeliveryLogRow = {
  member_id: string | null;
  operation_type: string | null;
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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
  if (method === 'PATCH') {
    return request.patch(url, options);
  }
  return request.post(url, options);
}

async function fetchJson<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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

async function findLeadEligibleMember(request: APIRequestContext, token: string): Promise<MemberSummary | null> {
  const listResult = await fetchJson<{ rows?: MemberSummary[] }>(
    request,
    'GET',
    '/members?page=1&pageSize=200&isActive=true',
    token
  );

  if (listResult.status !== 200) {
    return null;
  }

  const candidates = (listResult.body.rows ?? []).filter((member) => Boolean(member.member_id));
  for (const candidate of candidates) {
    const groupsResult = await fetchJson<MemberGroup[]>(request, 'GET', `/members/${candidate.member_id}/groups`, token);
    if (groupsResult.status !== 200) {
      continue;
    }

    const isLeadEligible = groupsResult.body.some((group) => {
      const name = String(group.group_name ?? '').toUpperCase();
      return name.includes('MENTOR') || name.includes('VOLUNTEER');
    });

    if (isLeadEligible) {
      return candidate;
    }
  }

  return null;
}

async function findParticipantGroupId(request: APIRequestContext, token: string): Promise<string | null> {
  const groupsResult = await fetchJson<GroupSummary[]>(request, 'GET', '/groups', token);
  if (groupsResult.status !== 200) {
    return null;
  }

  const match = groupsResult.body.find((group) =>
    String(group.group_name ?? '').toUpperCase().includes('PARTICIPANT')
  );

  return match?.group_id ?? null;
}

async function pollDeliveryLogs(
  request: APIRequestContext,
  token: string,
  eventId: string,
  operationType: string,
  timeoutMs = 60_000
): Promise<DeliveryLogRow[]> {
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

    if (response.status === 200 && (response.body.rows ?? []).length > 0) {
      return response.body.rows ?? [];
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return [];
}

async function fetchAssignments(request: APIRequestContext, token: string, eventId: string): Promise<AssignmentRow[]> {
  const result = await fetchJson<AssignmentRow[]>(request, 'GET', `/events/${eventId}/assignments`, token);
  expect(result.status).toBe(200);
  return result.body;
}

test.describe('API event lead lifecycle e2e', () => {
  test.skip(!apiBaseUrl, 'E2E_API_BASE_URL is required.');
  test.skip(!adminToken, 'PW_ADMIN_TOKEN is required for lead lifecycle validation.');
  test.setTimeout(180_000);

  test('excludes event lead from event_published notification recipients', async ({ request }) => {
    const lead = await findLeadEligibleMember(request, adminToken);
    test.skip(!lead, 'Need at least one active lead-eligible member for this test.');

    const participantGroupId = await findParticipantGroupId(request, adminToken);
    test.skip(!participantGroupId, 'Need a PARTICIPANT group for notification targeting.');

    const eventCreate = await fetchJson<{ event_id: string }>(
      request,
      'POST',
      '/events',
      adminToken,
      {
        title: `E2E Lead Notify ${randomUUID().slice(0, 8)}`,
        description: 'Validate lead exclusion from publish notifications',
        location: 'E2E Test Location',
        event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        invitation_stage: 'both',
        event_lead_member_id: lead?.member_id,
        notification_targets: [{ group_id: participantGroupId }],
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

    const publishLogs = await pollDeliveryLogs(request, adminToken, eventId, 'event_published');
    expect(publishLogs.length).toBeGreaterThan(0);

    const leadRows = publishLogs.filter((row) => row.member_id === lead?.member_id);
    expect(leadRows).toHaveLength(0);
  });

  test('auto-marks lead assignment attended when status transitions to completed', async ({ request }) => {
    const lead = await findLeadEligibleMember(request, adminToken);
    test.skip(!lead, 'Need at least one active lead-eligible member for this test.');

    const eventCreate = await fetchJson<{ event_id: string }>(
      request,
      'POST',
      '/events',
      adminToken,
      {
        title: `E2E Lead Complete ${randomUUID().slice(0, 8)}`,
        description: 'Validate lead auto-attendance on completion',
        location: 'E2E Test Location',
        event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        event_lead_member_id: lead?.member_id,
      }
    );

    expect(eventCreate.status).toBe(201);
    const eventId = eventCreate.body.event_id;
    expect(eventId).toBeTruthy();

    const beforeAssignments = await fetchAssignments(request, adminToken, eventId);
    const leadAssignment = beforeAssignments.find(
      (assignment) => assignment.member_id === lead?.member_id && assignment.role === 'LEAD'
    );
    expect(leadAssignment).toBeTruthy();
    expect(leadAssignment?.attended ?? null).toBeNull();

    const completeEvent = await fetchJson<Record<string, unknown>>(
      request,
      'PUT',
      `/events/${eventId}/status`,
      adminToken,
      { status: 'completed' }
    );
    expect(completeEvent.status).toBe(200);

    const afterAssignments = await fetchAssignments(request, adminToken, eventId);
    const updatedLeadAssignment = afterAssignments.find(
      (assignment) => assignment.member_id === lead?.member_id && assignment.role === 'LEAD'
    );

    expect(updatedLeadAssignment).toBeTruthy();
    expect(updatedLeadAssignment?.attended).toBe(true);
  });

  test('applies +0.5 participant recommendation increment for lead+participant attendance in completed events', async ({ request }) => {
    const lead = await findLeadEligibleMember(request, adminToken);
    test.skip(!lead, 'Need at least one active lead-eligible member for this test.');

    const recommendationEvent = await fetchJson<{ event_id: string }>(
      request,
      'POST',
      '/events',
      adminToken,
      {
        title: `E2E Lead Equity Seed ${randomUUID().slice(0, 8)}`,
        description: 'Seed recommendation baseline',
        location: 'E2E Test Location',
        event_date: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        event_lead_member_id: lead?.member_id,
      }
    );

    expect(recommendationEvent.status).toBe(201);
    const recommendationEventId = recommendationEvent.body.event_id;

    const responseSeed = await fetchJson<{ response: string }>(
      request,
      'POST',
      `/events/${recommendationEventId}/rsvp`,
      adminToken,
      {
        member_id: lead?.member_id,
        response: 'yes',
        response_role: 'PARTICIPANT',
      }
    );
    expect(responseSeed.status).toBe(200);

    const baselineRec = await fetchJson<{ rows?: Array<{ member_id: string; role_attended_year: number }> }>(
      request,
      'GET',
      `/events/${recommendationEventId}/assignment-recommendations?role=PARTICIPANT&limit=100`,
      adminToken
    );
    expect(baselineRec.status).toBe(200);

    const baselineRow = (baselineRec.body.rows ?? []).find((row) => row.member_id === lead?.member_id);
    expect(baselineRow).toBeTruthy();
    const baselineRoleAttendedYear = baselineRow?.role_attended_year ?? 0;

    const historyEvent = await fetchJson<{ event_id: string }>(
      request,
      'POST',
      '/events',
      adminToken,
      {
        title: `E2E Lead Equity Hist ${randomUUID().slice(0, 8)}`,
        description: 'Create completed lead+participant attendance history',
        location: 'E2E Test Location',
        event_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        event_lead_member_id: lead?.member_id,
        event_lead_secondary_roles: ['PARTICIPANT'],
      }
    );

    expect(historyEvent.status).toBe(201);
    const historyEventId = historyEvent.body.event_id;

    const publishHistoryEvent = await fetchJson<Record<string, unknown>>(
      request,
      'PUT',
      `/events/${historyEventId}/status`,
      adminToken,
      { status: 'published' }
    );
    expect(publishHistoryEvent.status).toBe(200);

    const historyAssignments = await fetchAssignments(request, adminToken, historyEventId);
    const leadHistoryAssignment = historyAssignments.find(
      (assignment) => assignment.member_id === lead?.member_id && assignment.role === 'LEAD'
    );
    const participantHistoryAssignment = historyAssignments.find(
      (assignment) => assignment.member_id === lead?.member_id && assignment.role === 'PARTICIPANT'
    );

    expect(leadHistoryAssignment).toBeTruthy();
    expect(participantHistoryAssignment).toBeTruthy();

    const markLeadAttended = await fetchJson<Record<string, unknown>>(
      request,
      'PATCH',
      `/events/${historyEventId}/assignments/${leadHistoryAssignment?.assignment_id}/attendance`,
      adminToken,
      { attended: true }
    );
    expect(markLeadAttended.status).toBe(200);

    const markParticipantAttended = await fetchJson<Record<string, unknown>>(
      request,
      'PATCH',
      `/events/${historyEventId}/assignments/${participantHistoryAssignment?.assignment_id}/attendance`,
      adminToken,
      { attended: true }
    );
    expect(markParticipantAttended.status).toBe(200);

    const completeHistoryEvent = await fetchJson<Record<string, unknown>>(
      request,
      'PUT',
      `/events/${historyEventId}/status`,
      adminToken,
      { status: 'completed' }
    );
    expect(completeHistoryEvent.status).toBe(200);

    const nextRec = await fetchJson<{ rows?: Array<{ member_id: string; role_attended_year: number }> }>(
      request,
      'GET',
      `/events/${recommendationEventId}/assignment-recommendations?role=PARTICIPANT&limit=100`,
      adminToken
    );
    expect(nextRec.status).toBe(200);

    const nextRow = (nextRec.body.rows ?? []).find((row) => row.member_id === lead?.member_id);
    expect(nextRow).toBeTruthy();

    const nextRoleAttendedYear = nextRow?.role_attended_year ?? 0;
    expect(nextRoleAttendedYear).toBeCloseTo(baselineRoleAttendedYear + 0.5, 5);
  });
});
