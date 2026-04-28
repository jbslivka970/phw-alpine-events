/**
 * authMiddleware.hardening.test.ts
 *
 * Supplements authMiddleware.test.ts with scenarios that validate the specific
 * break conditions identified during the DB-authoritative authz hardening audit.
 *
 * Scenarios NOT covered by the baseline suite:
 *
 *   H1. AUTH_ALLOW_TOKEN_ROLE_FALLBACK defaults to true → a token with ADMIN
 *       role claim grants ADMIN even when the [user] table has no entry.
 *       This is the DANGEROUS default that must be set to false in production.
 *
 *   H2. Email is absent from JWT claims (CIAM access tokens do not include
 *       email for custom API audiences), but the X-Id-Token-Email header
 *       carries the email → member resolves and USER role is granted.
 *
 *   H3. Duplicate active members share the same email address → auto-link
 *       is suppressed and the implicit USER role is NOT granted.
 *
 *   H4. AUTH_ALLOW_TOKEN_ROLE_FALLBACK=false with email-only member match →
 *       USER is still granted from member linkage (DB is authoritative, not
 *       token-role-blind for member-level access).
 *
 *   H5. tavf_creator in [user] table → roles = ['TAVF_CREATOR', 'USER'].
 */

// ---------------------------------------------------------------------------
// Mocks — must mirror authMiddleware.test.ts exactly
// ---------------------------------------------------------------------------

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    getSigningKey: jest.fn(
      (_kid: string, cb: (err: Error | null, key: { getPublicKey: () => string } | null) => void) => {
        cb(null, { getPublicKey: () => 'mock-public-key' });
      },
    ),
  }),
}));

jest.mock('jsonwebtoken', () => {
  const actual = jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken');
  return { ...actual, verify: jest.fn() };
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
// Imports
// ---------------------------------------------------------------------------

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool } from '../db';
import authenticate from '../middleware/auth';

// ---------------------------------------------------------------------------
// Helpers — same shapes as authMiddleware.test.ts
// ---------------------------------------------------------------------------

type QueryResult = { recordset: Record<string, unknown>[] };

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

function makeClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'bbbbbbbb-0000-0000-0000-000000000001',
    oid: 'bbbbbbbb-0000-0000-0000-000000000001',
    iss: 'https://mock.local/',
    aud: 'mock-client-id',
    ...overrides, // intentionally omit email by default to simulate CIAM access tokens
  };
}

function setVerifyClaims(claims: Record<string, unknown>): void {
  (jwt.verify as jest.Mock).mockImplementation(
    (_token: string, _getKey: unknown, _opts: unknown, cb: (err: null, decoded: unknown) => void) => {
      cb(null, claims);
    },
  );
}

function buildApp(): express.Application {
  const app = express();
  app.use(authenticate);
  app.get('/probe', (req: Request, res: Response) => {
    res.json({ roles: req.user?.roles ?? null, email: req.user?.email ?? null });
  });
  // Surface auth errors for status assertions
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'unexpected' });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'integration';
  process.env['AUTH_ENFORCE_MEMBER_PASSWORDLESS'] = 'false';
  delete process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'];
  jest.clearAllMocks();
});

afterEach(() => {
  process.env['NODE_ENV'] = originalNodeEnv;
});

// ---------------------------------------------------------------------------
// H1 — Token role fallback default (true) grants ADMIN from token claims
// ---------------------------------------------------------------------------

describe('authenticate middleware – hardening scenarios', () => {
  it('H1: ADMIN from token roles when fallback is enabled (default in non-prod) and no DB entry exists', async () => {
    // Documents the dev/E2E default: in non-production environments
    // AUTH_ALLOW_TOKEN_ROLE_FALLBACK defaults to TRUE so synthetic tokens
    // can mint roles without seeding the database.  In production this
    // default flips to FALSE — see H1b below.
    delete process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'];
    process.env['NODE_ENV'] = 'integration';

    setVerifyClaims(makeClaims({ email: 'stranger@example.com', roles: ['ADMIN'] }));

    const pool = buildMockPool([
      { recordset: [] }, // no identity link
      { recordset: [] }, // no member match (auto-link path)
      { recordset: [] }, // no member match (outer)
      { recordset: [] }, // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app).get('/probe').set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('ADMIN');
  });

  it('H1b: token roles are IGNORED in production when AUTH_ALLOW_TOKEN_ROLE_FALLBACK is unset', async () => {
    // Production hardening: NODE_ENV=production with the env var unset means
    // the [user] table is the single source of truth.  A token claiming ADMIN
    // must NOT grant ADMIN unless backed by a [user] row.
    delete process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'];
    process.env['NODE_ENV'] = 'production';

    setVerifyClaims(makeClaims({ email: 'stranger@example.com', roles: ['ADMIN'] }));

    const pool = buildMockPool([
      { recordset: [] }, // no identity link
      { recordset: [] }, // no member match (auto-link path)
      { recordset: [] }, // no member match (outer)
      { recordset: [] }, // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app).get('/probe').set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).not.toContain('ADMIN');
    expect(res.body.roles).toEqual([]);
  });

  // ── H2 — X-Id-Token-Email header rescues member resolution ─────────────

  it('H2: USER granted when email absent from JWT but X-Id-Token-Email header is present', async () => {
    // Simulates a CIAM access token with no email claim (the normal case for
    // custom API audiences).  The frontend sends X-Id-Token-Email as a
    // fallback.  Member resolution should succeed and grant USER.
    setVerifyClaims(makeClaims()); // no email field

    const pool = buildMockPool([
      { recordset: [] },                                         // no identity link
      { recordset: [{ member_id: 'member-uuid-h2a' }] },        // unique member found via header email
      { recordset: [] },                                         // MERGE (identity link created)
      { recordset: [{ member_id: 'member-uuid-h2a' }] },        // outer member lookup
      { recordset: [] },                                         // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token')
      .set('X-Id-Token-Email', 'member@example.com');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['USER']);
  });

  it('H2b: no email in JWT and no X-Id-Token-Email header → roles = [] (no silent USER grant)', async () => {
    setVerifyClaims(makeClaims()); // no email, no header

    const pool = buildMockPool([
      { recordset: [] }, // no identity link
      { recordset: [] }, // no member match
      { recordset: [] }, // outer member match
      { recordset: [] }, // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');
    // No email anywhere → nothing to link → empty roles
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
  });

  // ── H3 — Duplicate active members suppress implicit USER grant ───────────

  it('H3: duplicate active members by email returns empty roles (no implicit USER)', async () => {
    // When resolveUniqueActiveMemberByEmail finds 2 rows, the middleware should
    // not grant the implicit USER role — the member record is ambiguous.
    setVerifyClaims(makeClaims({ email: 'duplicate@example.com' }));

    const pool = buildMockPool([
      { recordset: [] },                                              // no identity link
      // Auto-link path: 2 active members with same email → skip auto-link
      { recordset: [{ member_id: 'member-dup-1' }, { member_id: 'member-dup-2' }] },
      // Outer resolveUniqueActiveMemberByEmail call: again 2 rows → null uniqueMember
      { recordset: [{ member_id: 'member-dup-1' }, { member_id: 'member-dup-2' }] },
      { recordset: [] }, // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    // Duplicate member emails: no unique member resolved → no implicit USER grant.
    expect(res.body.roles).toEqual([]);
  });

  // ── H4 — DB-authoritative fallback=false still grants USER via member link

  it('H4: fallback=false grants USER from member linkage even without [user] table entry', async () => {
    process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'] = 'false';
    // Token has no role claims; member is in DB (identity link present)
    setVerifyClaims(makeClaims({ email: 'linked@example.com' }));

    const pool = buildMockPool([
      { recordset: [{ member_id: 'member-uuid-h4' }] }, // existing identity link
      { recordset: [] },                                  // UPDATE link (void)
      { recordset: [{ member_id: 'member-uuid-h4' }] }, // outer member lookup
      { recordset: [] },                                  // no [user] entry
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    // USER comes from member linkage, not from token roles
    expect(res.body.roles).toEqual(['USER']);
  });

  // ── H5 — tavf_creator role is properly resolved ──────────────────────────

  it('H5: grants TAVF_CREATOR + USER when [user] table has role=tavf_creator', async () => {
    setVerifyClaims(makeClaims({ email: 'tavf@example.com' }));

    const pool = buildMockPool([
      { recordset: [] },                                          // no identity link
      { recordset: [{ member_id: 'member-uuid-h5' }] },          // unique member
      { recordset: [] },                                          // MERGE
      { recordset: [{ member_id: 'member-uuid-h5' }] },          // outer member lookup
      { recordset: [{ role: 'tavf_creator' }] },                 // [user] → tavf_creator
    ]);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const app = buildApp();
    const res = await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer mock-token');

    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('TAVF_CREATOR');
    expect(res.body.roles).toContain('USER');
    expect(res.body.roles).not.toContain('ADMIN');
    expect(res.body.roles).not.toContain('EVENT_CREATOR');
  });
});
