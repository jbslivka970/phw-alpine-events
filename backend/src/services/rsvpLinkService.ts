import jwt, { JwtPayload } from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomBytes } from 'crypto';
import { getPool, sql } from '../db';
import { loadRsvpLinkConfig } from '../config';

interface VerifiedRsvpToken {
  eventId: string;
  memberId: string;
  groupContextId?: string;
  expiresAt?: string;
}

interface MemberRsvpUrls {
  token: string;
  landingUrl: string;
  yesUrl: string;
  noUrl: string;
  maybeUrl: string;
  waitlistUrl: string;
}

type ResponseRole = 'MENTOR' | 'PARTICIPANT';
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_TOKEN_VERSION = 2;
const COMPACT_SIGNATURE_BYTES = 16;
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SHORT_CODE_LENGTH = 8;

let ensureShortLinkTablePromise: Promise<void> | null = null;

function createRsvpToken(eventId: string, memberId: string, groupContextId?: string): string {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    throw new Error('RSVP links are not configured.');
  }

  const expiresAtUnix = Math.floor(Date.now() / 1000) + (config.tokenExpiryHours * 60 * 60);
  const payload = encodeCompactPayload(eventId, memberId, expiresAtUnix, groupContextId);
  const signature = signCompactPayload(payload, config.tokenSecret);
  return Buffer.concat([payload, signature]).toString('base64url');
}

function verifyRsvpToken(token: string): VerifiedRsvpToken {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    throw new Error('RSVP links are not configured.');
  }

  const normalizedToken = normalizeIncomingToken(token);
  const compactVerified = verifyCompactToken(normalizedToken, config.tokenSecret);
  if (compactVerified) {
    return compactVerified;
  }

  const payload = jwt.verify(normalizedToken, config.tokenSecret, { algorithms: ['HS256'] }) as JwtPayload;
  if (payload['type'] !== 'event-rsvp') {
    throw new Error('Invalid RSVP token.');
  }

  const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : '';
  const memberId = typeof payload['memberId'] === 'string' ? payload['memberId'] : '';
  const groupContextId = typeof payload['groupContextId'] === 'string' ? payload['groupContextId'] : undefined;
  if (!eventId || !memberId) {
    throw new Error('Invalid RSVP token payload.');
  }

  return {
    eventId,
    memberId,
    groupContextId,
    expiresAt: typeof payload['exp'] === 'number' ? new Date(payload['exp'] * 1000).toISOString() : undefined,
  };
}

function decodePercentEncodedToken(token: string): string {
  let decoded = token;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function extractTokenCandidate(rawToken: string): string {
  const queryMatch = rawToken.match(/[?&]token=([^&#\s<>]+)/i);
  if (queryMatch?.[1]) {
    return queryMatch[1];
  }

  const pathMatch = rawToken.match(/\/rsvp\/([^/?#\s<>]+)/i);
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  return rawToken;
}

function tryDecodeWrappedToken(token: string): string {
  if (JWT_PATTERN.test(token) || token.includes('.')) {
    return token;
  }

  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8').trim();
    return JWT_PATTERN.test(decoded) ? decoded : token;
  } catch {
    return token;
  }
}

function normalizeIncomingToken(rawToken: string): string {
  let token = String(rawToken ?? '').trim();

  // Some SMS/email clients include link wrappers or punctuation when copied/opened.
  token = token
    .replace(/^['"“”`(\[]+/, '')
    .replace(/[\s'"“”`)\].,;!?]+$/g, '');

  token = decodePercentEncodedToken(token);
  token = extractTokenCandidate(token);
  token = decodePercentEncodedToken(token);

  // Recover token from wrapped text or link fragments when clients prepend/append noise.
  const jwtMatch = token.match(/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (jwtMatch?.[1]) {
    token = jwtMatch[1];
  } else {
    token = tryDecodeWrappedToken(token);
  }

  return token;
}

function buildMemberRsvpUrls(
  eventId: string,
  memberId: string,
  groupContextId?: string,
  preferredRole?: ResponseRole
): MemberRsvpUrls {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    throw new Error('RSVP links are not configured.');
  }

  const token = createRsvpToken(eventId, memberId, groupContextId);
  const path = `${config.frontendBaseUrl}/rsvp/${token}`;

  const createPresetUrl = (response: 'yes' | 'no' | 'maybe' | 'waitlist'): string => {
    const params = new URLSearchParams({ response });
    if (response === 'yes' || response === 'maybe' || response === 'waitlist') {
      params.set('role', preferredRole ?? 'PARTICIPANT');
    } else if (preferredRole) {
      params.set('role', preferredRole);
    }
    return `${path}?${params.toString()}`;
  };

  return {
    token,
    landingUrl: path,
    yesUrl: createPresetUrl('yes'),
    noUrl: createPresetUrl('no'),
    maybeUrl: createPresetUrl('maybe'),
    waitlistUrl: createPresetUrl('waitlist'),
  };
}

function encodeCompactPayload(eventId: string, memberId: string, expiresAtUnix: number, groupContextId?: string): Buffer {
  const eventBytes = uuidToBytes(eventId);
  const memberBytes = uuidToBytes(memberId);
  const groupBytes = groupContextId ? uuidToBytes(groupContextId) : undefined;
  const payloadLength = 1 + 4 + 16 + 16 + 1 + (groupBytes ? 16 : 0);
  const payload = Buffer.alloc(payloadLength);

  let offset = 0;
  payload.writeUInt8(COMPACT_TOKEN_VERSION, offset);
  offset += 1;
  payload.writeUInt32BE(expiresAtUnix, offset);
  offset += 4;
  eventBytes.copy(payload, offset);
  offset += 16;
  memberBytes.copy(payload, offset);
  offset += 16;
  payload.writeUInt8(groupBytes ? 1 : 0, offset);
  offset += 1;
  if (groupBytes) {
    groupBytes.copy(payload, offset);
  }

  return payload;
}

function signCompactPayload(payload: Buffer, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest().subarray(0, COMPACT_SIGNATURE_BYTES);
}

function verifyCompactToken(token: string, secret: string): VerifiedRsvpToken | null {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }

  const minLength = 1 + 4 + 16 + 16 + 1 + COMPACT_SIGNATURE_BYTES;
  if (decoded.length < minLength) {
    return null;
  }

  const payload = decoded.subarray(0, decoded.length - COMPACT_SIGNATURE_BYTES);
  const signature = decoded.subarray(decoded.length - COMPACT_SIGNATURE_BYTES);
  const expectedSignature = signCompactPayload(payload, secret);
  if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  const version = payload.readUInt8(0);
  if (version !== COMPACT_TOKEN_VERSION) {
    return null;
  }

  const expiresAtUnix = payload.readUInt32BE(1);
  const hasGroup = payload.readUInt8(37);
  if (hasGroup !== 0 && hasGroup !== 1) {
    return null;
  }

  const expectedPayloadLength = 1 + 4 + 16 + 16 + 1 + (hasGroup ? 16 : 0);
  if (payload.length !== expectedPayloadLength) {
    return null;
  }

  if (expiresAtUnix * 1000 <= Date.now()) {
    throw new Error('RSVP link has expired.');
  }

  const eventId = bytesToUuid(payload.subarray(5, 21));
  const memberId = bytesToUuid(payload.subarray(21, 37));
  const groupContextId = hasGroup ? bytesToUuid(payload.subarray(38, 54)) : undefined;

  return {
    eventId,
    memberId,
    groupContextId,
    expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
  };
}

function uuidToBytes(value: string): Buffer {
  if (!UUID_PATTERN.test(value)) {
    throw new Error('Invalid RSVP token payload.');
  }

  const normalized = value.replace(/-/g, '').toLowerCase();
  return Buffer.from(normalized, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function createShortRsvpUrlFromLandingUrl(landingUrl: string): Promise<string> {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    return landingUrl;
  }

  const tokenMatch = landingUrl.match(/\/rsvp\/([^/?#\s<>]+)/i);
  const token = tokenMatch?.[1] ? decodePercentEncodedToken(tokenMatch[1]) : '';
  if (!token) {
    return landingUrl;
  }

  try {
    const code = await createShortRsvpCode(token);
    return `${config.frontendBaseUrl}/go/${code}`;
  } catch (error) {
    console.warn('[rsvpLinkService] Failed to create short RSVP code; falling back to landing URL.', error);
    return landingUrl;
  }
}

async function resolveShortRsvpToken(code: string): Promise<string | null> {
  const normalizedCode = String(code ?? '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalizedCode)) {
    return null;
  }

  await ensureShortLinkTable();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('short_code', sql.NVarChar(20), normalizedCode)
    .query<{ token: string }>(
      `SELECT TOP 1 token
       FROM dbo.rsvp_short_link
       WHERE short_code = @short_code
         AND expires_at > GETUTCDATE()`
    );

  const row = result.recordset[0];
  return row?.token ?? null;
}

async function createShortRsvpCode(token: string): Promise<string> {
  await ensureShortLinkTable();
  const pool = await getPool();

  const existing = await pool
    .request()
    .input('token', sql.NVarChar(1024), token)
    .query<{ short_code: string }>(
      `SELECT TOP 1 short_code
       FROM dbo.rsvp_short_link
       WHERE token = @token
         AND expires_at > GETUTCDATE()
       ORDER BY created_at DESC`
    );

  if (existing.recordset[0]?.short_code) {
    return existing.recordset[0].short_code;
  }

  const parsed = verifyRsvpToken(token);
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : new Date(Date.now() + (7 * 24 * 60 * 60 * 1000));
  const expiresAtIso = expiresAt.toISOString();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateShortCode();
    const inserted = await pool
      .request()
      .input('short_code', sql.NVarChar(20), candidate)
      .input('token', sql.NVarChar(1024), token)
      .input('event_id', sql.UniqueIdentifier, parsed.eventId)
      .input('member_id', sql.UniqueIdentifier, parsed.memberId)
      .input('expires_at', sql.DateTime2, expiresAtIso)
      .query<{ inserted: number }>(
        `IF NOT EXISTS (
            SELECT 1
            FROM dbo.rsvp_short_link
            WHERE short_code = @short_code
        )
        BEGIN
            INSERT INTO dbo.rsvp_short_link (
              short_link_id,
              short_code,
              token,
              event_id,
              member_id,
              expires_at,
              created_at
            )
            VALUES (
              NEWID(),
              @short_code,
              @token,
              @event_id,
              @member_id,
              @expires_at,
              GETUTCDATE()
            );

            SELECT 1 AS inserted;
        END
        ELSE
        BEGIN
            SELECT 0 AS inserted;
        END`
      );

    if (inserted.recordset[0]?.inserted === 1) {
      return candidate;
    }
  }

  throw new Error('Unable to allocate short RSVP code.');
}

function generateShortCode(length = SHORT_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

async function ensureShortLinkTable(): Promise<void> {
  if (!ensureShortLinkTablePromise) {
    ensureShortLinkTablePromise = (async () => {
      const pool = await getPool();
      await pool.request().query(
        `IF OBJECT_ID(N'dbo.rsvp_short_link', N'U') IS NULL
         BEGIN
            CREATE TABLE dbo.rsvp_short_link (
              short_link_id UNIQUEIDENTIFIER NOT NULL,
              short_code NVARCHAR(20) NOT NULL,
                token NVARCHAR(1024) NOT NULL,
              event_id UNIQUEIDENTIFIER NULL,
              member_id UNIQUEIDENTIFIER NULL,
              expires_at DATETIME2 NOT NULL,
              created_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
              CONSTRAINT PK_rsvp_short_link PRIMARY KEY (short_link_id),
              CONSTRAINT UQ_rsvp_short_link_code UNIQUE (short_code)
            );

            CREATE INDEX IX_rsvp_short_link_expires_at ON dbo.rsvp_short_link (expires_at);
         END`
      );
    })();
  }

  await ensureShortLinkTablePromise;
}

export { buildMemberRsvpUrls, createRsvpToken, verifyRsvpToken, createShortRsvpUrlFromLandingUrl, resolveShortRsvpToken };
export type { MemberRsvpUrls, VerifiedRsvpToken, ResponseRole };