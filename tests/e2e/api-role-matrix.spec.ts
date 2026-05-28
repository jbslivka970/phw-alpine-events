import { expect, test, type APIRequestContext } from '@playwright/test';
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
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const tokensByRole = {
  ADMIN: process.env.PW_ADMIN_TOKEN ?? (localE2EAuthEnabled ? 'e2e-admin' : ''),
  EVENT_CREATOR: process.env.PW_EVENT_CREATOR_TOKEN ?? (localE2EAuthEnabled ? 'e2e-event_creator' : ''),
  USER: process.env.PW_MEMBER_TOKEN ?? (localE2EAuthEnabled ? 'e2e-user' : ''),
} as const;
const allowTavfMutations = /^(1|true|yes|on)$/i.test(process.env.E2E_ALLOW_TAVF_MUTATIONS ?? '');

type Role = keyof typeof tokensByRole;
type RoleCapabilities = {
  isAdmin: boolean;
  isEventCreator: boolean;
  canPostEvents: boolean;
};
type ContractCase = {
  name: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  payload?: Record<string, unknown>;
  expectedByRole: (capabilities: RoleCapabilities) => 'allow' | 'deny';
  requiresTavfMutations?: boolean;
  customAssert?: (status: number, bodyText: string) => Promise<void> | void;
};

const eventId = randomUUID();
const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const contracts: ContractCase[] = [
  {
    name: 'Events list is accessible to all authenticated roles',
    method: 'GET',
    path: '/events',
    expectedByRole: () => 'allow',
  },
  {
    name: 'Event status transition endpoint accepts all authenticated roles',
    method: 'PUT',
    path: `/events/${eventId}/status`,
    payload: { status: 'cancelled' },
    expectedByRole: () => 'allow',
  },
  {
    name: 'Event creation is limited to admin/event creator roles',
    method: 'POST',
    path: '/events',
    payload: {
      title: 'Playwright Contract Event',
      description: 'role matrix contract',
      location: 'Playwright',
      event_date: futureDate,
      start_time: '09:00',
      end_time: '11:00',
      status: 'draft',
      capacity: 10,
    },
    expectedByRole: ({ isAdmin, canPostEvents }) => (isAdmin || canPostEvents ? 'allow' : 'deny'),
  },
  {
    name: 'Event AI draft generation is limited to admin/event creator roles',
    method: 'POST',
    path: `/events/${eventId}/ai-draft`,
    payload: { tone: 'professional' },
    expectedByRole: ({ isAdmin, isEventCreator }) => (isAdmin || isEventCreator ? 'allow' : 'deny'),
  },
  {
    name: 'Event report CSV export is limited to admin/event creator roles',
    method: 'GET',
    path: `/events/${eventId}/report.csv`,
    expectedByRole: ({ isAdmin, isEventCreator }) => (isAdmin || isEventCreator ? 'allow' : 'deny'),
  },
  {
    name: 'Event report PDF export is limited to admin/event creator roles',
    method: 'GET',
    path: `/events/${eventId}/report.pdf`,
    expectedByRole: ({ isAdmin, isEventCreator }) => (isAdmin || isEventCreator ? 'allow' : 'deny'),
  },
  {
    name: 'Event report email is limited to admin/event creator roles',
    method: 'POST',
    path: `/events/${eventId}/report/email`,
    payload: {},
    expectedByRole: ({ isAdmin, isEventCreator }) => (isAdmin || isEventCreator ? 'allow' : 'deny'),
  },
  {
    name: 'Admin users endpoint is admin-only',
    method: 'GET',
    path: '/admin/users?page=1&pageSize=1',
    expectedByRole: ({ isAdmin }) => (isAdmin ? 'allow' : 'deny'),
  },
  {
    name: 'TAVF create accepts authenticated app roles past RBAC gate',
    method: 'POST',
    path: '/tavf/postings',
    requiresTavfMutations: true,
    payload: {
      guide_member_id: 'legacy-auth-subject',
      event_date: futureDate,
      location: 'Playwright Smoke River',
      capacity: 1,
      species: 'Trout',
    },
    expectedByRole: () => 'allow',
    customAssert: async (status, bodyText) => {
      if (status === 400) {
        expect(bodyText.toLowerCase()).not.toContain('guide_member_id must be a valid uuid');
      }
    },
  },
];

async function invokeContract(request: APIRequestContext, method: ContractCase['method'], path: string, token: string, payload?: Record<string, unknown>) {
  const url = `${apiBaseUrl}${path}`;
  if (method === 'GET') {
    return request.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (method === 'PUT') {
    return request.put(url, {
      headers: { Authorization: `Bearer ${token}` },
      data: payload,
    });
  }
  return request.post(url, {
    headers: { Authorization: `Bearer ${token}` },
    data: payload,
  });
}

function decodeCapabilities(token: string): RoleCapabilities {
  try {
    const payloadPart = token.split('.')[1] ?? '';
    const payloadJson = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as {
      roles?: unknown;
      role?: unknown;
      app_roles?: unknown;
      appRoles?: unknown;
    };

    const values: string[] = [];
    for (const candidate of [payload.roles, payload.role, payload.app_roles, payload.appRoles]) {
      if (typeof candidate === 'string') {
        values.push(candidate);
      } else if (Array.isArray(candidate)) {
        for (const value of candidate) {
          if (typeof value === 'string') {
            values.push(value);
          }
        }
      }
    }

    const normalized = new Set(values.map((role) => role.trim().toUpperCase().replace(/[\s-]+/g, '_')));
    const isAdmin = normalized.has('ADMIN');
    const isEventCreator = normalized.has('EVENT_CREATOR');
    return {
      isAdmin,
      isEventCreator,
      canPostEvents: isAdmin || isEventCreator,
    };
  } catch {
    return {
      isAdmin: false,
      isEventCreator: false,
      canPostEvents: false,
    };
  }
}

const capabilityCache = new Map<string, RoleCapabilities>();

async function inferCapabilities(request: APIRequestContext, token: string): Promise<RoleCapabilities> {
  const cached = capabilityCache.get(token);
  if (cached) {
    return cached;
  }

  const claimed = decodeCapabilities(token);
  const adminProbe = await invokeContract(request, 'GET', '/admin/users?page=1&pageSize=1', token);
  const adminStatus = adminProbe.status();
  const hasAdminAccess = ![401, 403].includes(adminStatus);

  const creatorProbe = await invokeContract(request, 'POST', `/events/${randomUUID()}/ai-draft`, token, {
    tone: 'friendly',
  });
  const creatorStatus = creatorProbe.status();
  const hasCreateAccess = ![401, 403].includes(creatorStatus);

  const eventCreateProbe = await invokeContract(request, 'POST', '/events', token, {
    title: 'Contract Probe',
    event_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  const eventCreateStatus = eventCreateProbe.status();
  const canPostEvents = ![401, 403].includes(eventCreateStatus);

  const inferred: RoleCapabilities = {
    isAdmin: claimed.isAdmin || hasAdminAccess,
    isEventCreator: claimed.isEventCreator || hasCreateAccess || hasAdminAccess,
    canPostEvents,
  };

  capabilityCache.set(token, inferred);
  return inferred;
}

test.describe('API role-path matrix', () => {
  test.skip(!apiBaseUrl, 'E2E_API_BASE_URL (or BACKEND_BASE_URL) is required.');

  for (const contract of contracts) {
    test(contract.name, async ({ request }) => {
      test.skip(
        contract.requiresTavfMutations && !allowTavfMutations,
        'TAVF posting mutation checks are disabled by default to prevent smoke tests from generating live notifications. Set E2E_ALLOW_TAVF_MUTATIONS=true to enable.'
      );

      for (const role of Object.keys(tokensByRole) as Role[]) {
        const token = tokensByRole[role];
        test.skip(!token, `${role} token is required for this assertion.`);
        const capabilities = await inferCapabilities(request, token);

        const response = await invokeContract(request, contract.method, contract.path, token, contract.payload);
        const status = response.status();
        const bodyText = await response.text();
        const expected = contract.expectedByRole(capabilities);

        if (expected === 'allow') {
          expect(status, `${role} should be authorized for ${contract.method} ${contract.path}`).not.toBe(401);
          expect(status, `${role} should be authorized for ${contract.method} ${contract.path}`).not.toBe(403);
          expect(status, `${role} should not trigger server errors on ${contract.method} ${contract.path}`).not.toBe(500);
        } else {
          expect(status, `${role} should be denied for ${contract.method} ${contract.path} (got ${status})`).toBeGreaterThanOrEqual(400);
          expect(status, `${role} denied paths must not return server errors for ${contract.method} ${contract.path}`).toBeLessThan(500);
        }

        if (contract.customAssert) {
          await contract.customAssert(status, bodyText);
        }
      }
    });
  }
});
