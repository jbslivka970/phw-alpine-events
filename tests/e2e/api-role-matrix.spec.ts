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
const tokensByRole = {
  ADMIN: process.env.PW_ADMIN_TOKEN ?? '',
  EVENT_CREATOR: process.env.PW_EVENT_CREATOR_TOKEN ?? '',
  USER: process.env.PW_MEMBER_TOKEN ?? '',
} as const;

type Role = keyof typeof tokensByRole;
type RoleCapabilities = {
  isAdmin: boolean;
  isEventCreator: boolean;
};
type ContractCase = {
  name: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  payload?: Record<string, unknown>;
  expectedByRole: (capabilities: RoleCapabilities) => 'allow' | 'deny';
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
    expectedByRole: ({ isAdmin, isEventCreator }) => (isAdmin || isEventCreator ? 'allow' : 'deny'),
  },
  {
    name: 'Admin users endpoint is admin-only',
    method: 'GET',
    path: '/admin/users?page=1&pageSize=1',
    expectedByRole: ({ isAdmin }) => (isAdmin ? 'allow' : 'deny'),
  },
  {
    name: 'TAVF create denies admin and allows non-admin roles past RBAC gate',
    method: 'POST',
    path: '/tavf/postings',
    payload: {
      guide_member_id: 'legacy-auth-subject',
      event_date: futureDate,
      location: 'Playwright Smoke River',
      capacity: 1,
      species: 'Trout',
    },
    expectedByRole: ({ isAdmin }) => (isAdmin ? 'deny' : 'allow'),
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

function decodeCapabilities(token: string, fallbackRole: Role): RoleCapabilities {
  const fallbackCapabilities: RoleCapabilities = {
    isAdmin: fallbackRole === 'ADMIN',
    isEventCreator: fallbackRole === 'EVENT_CREATOR',
  };

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
    return {
      isAdmin: fallbackCapabilities.isAdmin || normalized.has('ADMIN'),
      isEventCreator: fallbackCapabilities.isEventCreator || normalized.has('EVENT_CREATOR'),
    };
  } catch {
    return fallbackCapabilities;
  }
}

test.describe('API role-path matrix', () => {
  test.skip(!apiBaseUrl, 'E2E_API_BASE_URL (or BACKEND_BASE_URL) is required.');

  for (const contract of contracts) {
    test(contract.name, async ({ request }) => {
      for (const role of Object.keys(tokensByRole) as Role[]) {
        const token = tokensByRole[role];
        test.skip(!token, `${role} token is required for this assertion.`);
        const capabilities = decodeCapabilities(token, role);

        const response = await invokeContract(request, contract.method, contract.path, token, contract.payload);
        const status = response.status();
        const bodyText = await response.text();
        const expected = contract.expectedByRole(capabilities);

        if (expected === 'allow') {
          expect(status, `${role} should be authorized for ${contract.method} ${contract.path}`).not.toBe(401);
          expect(status, `${role} should be authorized for ${contract.method} ${contract.path}`).not.toBe(403);
          expect(status, `${role} should not trigger server errors on ${contract.method} ${contract.path}`).not.toBe(500);
        } else {
          expect([401, 403], `${role} should be denied for ${contract.method} ${contract.path}`).toContain(status);
        }

        if (contract.customAssert) {
          await contract.customAssert(status, bodyText);
        }
      }
    });
  }
});
