/**
 * Integration tests for the authenticate middleware.
 *
 * These tests exercise the full DB-driven role resolution path in auth.ts by:
 *   - Overriding NODE_ENV to bypass the test-mode shortcut in the middleware
 *   - Mocking jwks-rsa and jsonwebtoken to avoid RS256 key infrastructure
 *   - Mocking the DB pool to control query results per test scenario
 *   - Mounting the middleware on a minimal Express app and asserting req.user.roles
 *
 * Scenarios covered:
 *   1. App admin in [user] table → roles = ['ADMIN']
 *   2. Linked member (identity_link) → roles = ['USER']
 *   3. Email-matched member (no prior link) → roles = ['USER']
 *   4. Unrecognised user (no link, no email match, no [user] entry) → roles = []
 *   5. Token role fallback disabled → token roles ignored, only app roles used
 *   6. Event creator in [user] table → roles = ['EVENT_CREATOR', 'USER']
 */

// ---------------------------------------------------------------------------
// Mock heavy/ESM dependencies BEFORE importing auth.ts
// ---------------------------------------------------------------------------

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    getSigningKey: jest.fn(
      (_kid: string, cb: (err: Error | null, key: { getPublicKey: () => string } | null) => void) => {
        cb(null, { getPublicKey: () => 'mock-public-key' });
      }
    ),
  }),
}));

jest.mock('jsonwebtoken', () => {
  const actual = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
  return {
    ...actual,
    verify: jest.fn(),
  };
});

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: jest.fn((n?: number) => (n ? `NVarChar(${n})` : 'NVarChar')),
    UniqueIdentifier: 'UniqueIdentifier',
    Bit: 'Bit',
    Int: 'Int',
    DateTime: 'DateTime',
  },
}));

jest.mock('../config', () => ({
  loadAuthConfig: jest.fn().mockReturnValue({
    isConfigured: true,
    jwksUri: 'https://mock.local/.well-known/jwks.json',
    clientId: 'mock-client-id',
    issuer: 'https://mock.local/',
  }),
  loadEntraProvisioningConfig: jest.fn().mockReturnValue({ isConfigured: false }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool } from '../db';
import { apiLimiter } from '../middleware/rateLimiter';

// Import the middleware under test. NODE_ENV will be overridden per test so
// that the "test-mode shortcut" inside authenticate() is bypassed.
import authenticate from '../middleware/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryResult = { recordset: Record<string, unknown>[] };

/**
 * Builds a mock mssql pool whose .request().input().query() calls are served
 * from a FIFO queue of pre-programmed results.  Unmatched calls resolve with
 * an empty recordset so the middleware stays resilient.
 */
function buildMockPool(responses: QueryResult[]): { request: jest.Mock } {
  const queue = [...responses];
  const requestObj = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(() => {
      const next = queue.shift();
      return Promise.resolve(next ?? { recordset: [] });
    }),
  };
  return { request: jest.fn().mockReturnValue(requestObj) };
}

/** Default JWT claims used across tests. */
function makeClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'aaaaaaaa-0000-0000-0000-000000000001',
    oid: 'aaaaaaaa-0000-0000-0000-000000000001',
    iss: 'https://mock.local/',
    aud: 'mock-client-id',
    email: 'user@example.com',
    ...overrides,
  };
}

/** Wire jwt.verify to call back with the given claims (simulates a valid token). */
function setVerifyClaims(claims: Record<string, unknown>): void {
  (jwt.verify as jest.Mock).mockImplementation(
    (_token: string, _getKey: unknown, _opts: unknown, callback: (err: null, decoded: unknown) => void) => {
      callback(null, claims);
    }
  );
}

/** Build an Express app with the authenticate middleware and a probe route. */
function buildApp(): express.Application {
  const app = express();
  app.use(apiLimiter);
  app.use(authenticate);
  app.get('/probe', (req: Request, res: Response) => {
    res.json({ roles: req.user?.roles ?? null, email: req.user?.email ?? null });
  });
  // Catch 4xx from auth before they bubble
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'unexpected' });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env['NODE_ENV'];
  // Bypass the `if (process.env.NODE_ENV === 'test')` shortcut in auth.ts
  process.env['NODE_ENV'] = 'integration';
  // Ensure token fallback is on by default for most tests
  delete process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'];
  // Disable password-less enforcement to keep tests focused on role resolution
  process.env['AUTH_ENFORCE_MEMBER_PASSWORDLESS'] = 'false';
  jest.clearAllMocks();
});

afterEach(() => {
  process.env['NODE_ENV'] = originalNodeEnv;
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('authenticate middleware – DB-driven role resolution', () => {
  it('grants ADMIN when user is in [user] table with role=admin', async () => {
    setVerifyClaims(makeClaims());

    // DB call order:
    //   1. SELECT member_identity_link (no existing link)
    //   2. SELECT TOP 2 member by email (upsertMemberIdentityLink path – 1 match → MERGE)
    //   3. MERGE member_identity_link (void / no recordset needed)
    //   4. SELECT TOP 2 member by email (resolveUniqueActiveMemberByEmail outer call – 1 match)
    //   5. SELECT TOP 1 [user] by oid/email → admin
    const pool = buildMockPool([
      { recordset: [] },                                          // 1. no identity link
      { recordset: [{ member_id: 'member-uuid-001' }] },         // 2. unique member found
      { recordset: [] },                                          // 3. MERGE (no return)
      { recordset: [{ member_id: 'member-uuid-001' }] },         // 4. resolveUniqueActiveMemberByEmail
      { recordset: [{ role: 'admin' }] },                        // 5. [user] lookup
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('ADMIN');
  });

  it('grants USER when user has an existing identity link to a member', async () => {
    setVerifyClaims(makeClaims());

    // DB call order:
    //   1. SELECT member_identity_link → linked (returns member_id)
    //   2. UPDATE member_identity_link (void)
    //   3. SELECT TOP 2 member by email (resolveUniqueActiveMemberByEmail outer call)
    //   4. SELECT TOP 1 [user] → no app account
    const pool = buildMockPool([
      { recordset: [{ member_id: 'member-uuid-002' }] },         // 1. existing link
      { recordset: [] },                                          // 2. UPDATE (void)
      { recordset: [{ member_id: 'member-uuid-002' }] },         // 3. unique member
      { recordset: [] },                                          // 4. no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['USER']);
  });

  it('grants USER via email-only member match (no prior identity link)', async () => {
    setVerifyClaims(makeClaims({ oid: undefined }));

    // DB call order:
    //   1. SELECT member_identity_link → no link (oid absent)
    //   2. SELECT TOP 2 member by email → 1 match (auto-link path)
    //   3. MERGE member_identity_link
    //   4. SELECT TOP 2 member by email (resolveUniqueActiveMemberByEmail outer)
    //   5. SELECT TOP 1 [user] → no app account
    const pool = buildMockPool([
      { recordset: [] },
      { recordset: [{ member_id: 'member-uuid-003' }] },
      { recordset: [] },
      { recordset: [{ member_id: 'member-uuid-003' }] },
      { recordset: [] },
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['USER']);
  });

  it('returns no roles for a completely unrecognised user', async () => {
    setVerifyClaims(makeClaims({ email: 'stranger@example.com' }));

    // DB call order:
    //   1. SELECT member_identity_link → no link
    //   2. SELECT TOP 2 member by email → 0 matches (no auto-link)
    //   3. SELECT TOP 2 member by email (outer) → 0 matches
    //   4. SELECT TOP 1 [user] → no app account
    const pool = buildMockPool([
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
  });

  it('ignores token roles when AUTH_ALLOW_TOKEN_ROLE_FALLBACK=false', async () => {
    process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'] = 'false';
    // Token claims include ADMIN role; DB has no app account and no member link
    setVerifyClaims(makeClaims({ roles: ['ADMIN'] }));

    const pool = buildMockPool([
      { recordset: [] }, // no identity link
      { recordset: [] }, // no member match (auto-link path)
      { recordset: [] }, // no member match (outer)
      { recordset: [] }, // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
  });

  it('grants EVENT_CREATOR + USER when [user] table has role=event_creator', async () => {
    setVerifyClaims(makeClaims());

    const pool = buildMockPool([
      { recordset: [] },                                          // no identity link
      { recordset: [{ member_id: 'member-uuid-005' }] },         // unique member
      { recordset: [] },                                          // MERGE
      { recordset: [{ member_id: 'member-uuid-005' }] },         // outer member lookup
      { recordset: [{ role: 'event_creator' }] },                // [user] → event_creator
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('EVENT_CREATOR');
    expect(res.body.roles).toContain('USER');
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp();
    const res = await request(app).get('/probe');
    expect(res.status).toBe(401);
  });

  it('returns 401 when jwt.verify signals an error', async () => {
    (jwt.verify as jest.Mock).mockImplementation(
      (_token: string, _getKey: unknown, _opts: unknown, callback: (err: Error, decoded: null) => void) => {
        callback(new Error('token expired'), null);
      }
    );

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer bad-token');

    expect(res.status).toBe(401);
  });
});
