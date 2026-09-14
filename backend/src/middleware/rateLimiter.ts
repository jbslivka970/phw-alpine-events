import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getPool, sql } from '../db';

interface RateLimitRow {
  request_count: number;
  window_start: Date;
  expires_at: Date;
}

interface SharedRateLimitOptions {
  scope: string;
  windowMs: number;
  max: number;
}

const RATE_LIMIT_MESSAGE = { error: 'Too many requests, please try again later.' };

function isSqlRateLimitRequired(): boolean {
  const configured = process.env['SQL_RATE_LIMIT_REQUIRED'];
  if (configured !== undefined) {
    return /^(1|true|yes|on)$/i.test(configured);
  }
  return process.env['NODE_ENV'] === 'production';
}

function hashRequestIdentity(req: Request, scope: string): Buffer {
  const authorization = req.get('authorization');
  const clientIdentity = authorization
    ? crypto.createHash('sha256').update(authorization).digest('hex')
    : req.ip;
  const routeIdentity = `${req.method}:${req.baseUrl}${req.route?.path ?? req.path}`;
  const secret = process.env['RATE_LIMIT_HASH_SECRET'];
  const payload = `${scope}\n${routeIdentity}\n${clientIdentity}`;
  return secret
    ? crypto.createHmac('sha256', secret).update(payload).digest()
    : crypto.createHash('sha256').update(payload).digest();
}

async function consumeSharedLimit(req: Request, options: SharedRateLimitOptions): Promise<RateLimitRow> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('key_hash', sql.VarBinary(32), hashRequestIdentity(req, options.scope))
    .input('scope', sql.NVarChar(50), options.scope)
    .input('window_ms', sql.Int, options.windowMs)
    .query<RateLimitRow>(
      `SET XACT_ABORT ON;
       DECLARE @now DATETIME2 = SYSUTCDATETIME();
       DECLARE @window_start DATETIME2 = DATEADD(
         millisecond,
         -(DATEDIFF_BIG(millisecond, CONVERT(DATETIME2, '1970-01-01'), @now) % @window_ms),
         @now
       );
       DECLARE @expires_at DATETIME2 = DATEADD(millisecond, @window_ms, @window_start);

       MERGE dbo.rate_limit_window WITH (HOLDLOCK) AS target
       USING (SELECT @key_hash AS key_hash, @window_start AS window_start) AS source
          ON target.key_hash = source.key_hash
         AND target.window_start = source.window_start
       WHEN MATCHED THEN
         UPDATE SET request_count = target.request_count + 1,
                    expires_at = @expires_at
       WHEN NOT MATCHED THEN
         INSERT (key_hash, scope, window_start, request_count, expires_at)
         VALUES (@key_hash, @scope, @window_start, 1, @expires_at)
       OUTPUT inserted.request_count, inserted.window_start, inserted.expires_at;`
    );

  const row = result.recordset[0];
  if (!row) {
    throw new Error('SQL rate limiter did not return a counter row.');
  }
  return row;
}

function createSharedRateLimiter(options: SharedRateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const row = await consumeSharedLimit(req, options);
      const remaining = Math.max(0, options.max - row.request_count);
      res.setHeader('RateLimit-Limit', String(options.max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((row.expires_at.getTime() - Date.now()) / 1000))));

      if (row.request_count > options.max) {
        res.status(429).json(RATE_LIMIT_MESSAGE);
        return;
      }
      next();
    } catch (error) {
      console.error('[rateLimiter] SQL shared limiter unavailable', error);
      if (isSqlRateLimitRequired()) {
        res.status(503).json({ error: 'Request protection is temporarily unavailable.' });
        return;
      }
      next();
    }
  };
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MESSAGE,
});

const writeLimiter = createSharedRateLimiter({
  scope: 'write',
  windowMs: 60 * 1000,
  max: 20,
});

const publicLimiter = createSharedRateLimiter({
  scope: 'public',
  windowMs: 60 * 1000,
  max: 60,
});

export { apiLimiter, consumeSharedLimit, createSharedRateLimiter, publicLimiter, writeLimiter };