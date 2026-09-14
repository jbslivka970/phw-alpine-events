import express from 'express';
import request from 'supertest';
import { getPool } from '../db';
import { createSharedRateLimiter } from '../middleware/rateLimiter';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    Int: 'Int',
    VarBinary: jest.fn((length: unknown) => `VarBinary(${String(length)})`),
    NVarChar: jest.fn((length: unknown) => `NVarChar(${String(length)})`),
  },
}));

type CounterResult = { request_count: number; window_start: Date; expires_at: Date };

function mockCounters(results: CounterResult[]) {
  const inputs: Array<Record<string, unknown>> = [];
  const queries: string[] = [];
  (getPool as jest.Mock).mockResolvedValue({
    request: () => {
      const params: Record<string, unknown> = {};
      return {
        input(name: string, _type: unknown, value: unknown) {
          params[name] = value;
          return this;
        },
        async query(sqlText: string) {
          inputs.push(params);
          queries.push(sqlText);
          return { recordset: [results.shift()] };
        },
      };
    },
  });
  return { inputs, queries };
}

function createApp() {
  const app = express();
  app.post('/write', createSharedRateLimiter({ scope: 'test-write', windowMs: 60_000, max: 2 }), (_req, res) => {
    res.status(204).send();
  });
  return app;
}

describe('SQL shared rate limiter', () => {
  const windowStart = new Date('2026-09-14T00:00:00.000Z');
  const expiresAt = new Date(Date.now() + 60_000);
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    delete process.env['SQL_RATE_LIMIT_REQUIRED'];
    jest.clearAllMocks();
  });

  it('shares counts across middleware instances without persisting raw identity', async () => {
    const capture = mockCounters([1, 2, 3].map((request_count) => ({ request_count, window_start: windowStart, expires_at: expiresAt })));
    const firstInstance = createApp();
    const secondInstance = createApp();

    await request(firstInstance).post('/write').expect(204);
    await request(secondInstance).post('/write').expect(204);
    await request(firstInstance).post('/write').expect(429);

    expect(capture.queries[0]).toContain('MERGE dbo.rate_limit_window WITH (HOLDLOCK)');
    expect(capture.inputs[0]?.['key_hash']).toBeInstanceOf(Buffer);
    expect((capture.inputs[0]?.['key_hash'] as Buffer)).toHaveLength(32);
    expect(capture.inputs[0]).not.toHaveProperty('ip');
  });

  it('allows requests again when SQL returns a new-window count', async () => {
    mockCounters([
      { request_count: 3, window_start: windowStart, expires_at: expiresAt },
      { request_count: 1, window_start: new Date(windowStart.getTime() + 60_000), expires_at: new Date(expiresAt.getTime() + 60_000) },
    ]);
    const app = createApp();

    await request(app).post('/write').expect(429);
    await request(app).post('/write').expect(204);
  });

  it('fails closed in production when shared coordination is unavailable', async () => {
    process.env['NODE_ENV'] = 'production';
    (getPool as jest.Mock).mockRejectedValue(new Error('schema not deployed'));

    await request(createApp()).post('/write').expect(503, {
      error: 'Request protection is temporarily unavailable.',
    });
  });

  it('allows nonproduction rollout traffic when the additive schema is unavailable', async () => {
    process.env['NODE_ENV'] = 'development';
    (getPool as jest.Mock).mockRejectedValue(new Error('schema not deployed'));

    await request(createApp()).post('/write').expect(204);
  });
});