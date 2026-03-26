import jwt, { JwtPayload } from 'jsonwebtoken';
import { loadRsvpLinkConfig } from '../config';

interface VerifiedEmailPreferenceToken {
  memberId: string;
  email?: string;
  expiresAt?: string;
}

function parseExpiryHours(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getTokenSecret(): string {
  const explicit = process.env['EMAIL_PREFERENCE_TOKEN_SECRET'];
  if (explicit) {
    return explicit;
  }

  const shared = process.env['RSVP_TOKEN_SECRET'];
  if (shared) {
    return shared;
  }

  const config = loadRsvpLinkConfig();
  if (config.tokenSecret) {
    return config.tokenSecret;
  }

  throw new Error('Email preference links are not configured.');
}

function getPublicApiBaseUrl(): string {
  const explicit = process.env['PUBLIC_API_BASE_URL'] || process.env['API_BASE_URL'];
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  const appServiceHost = process.env['WEBSITE_HOSTNAME'];
  if (appServiceHost) {
    return `https://${appServiceHost}`;
  }

  const nodeEnv = process.env['NODE_ENV'] || 'development';
  if (nodeEnv !== 'production') {
    return 'http://localhost:3001';
  }

  throw new Error('PUBLIC_API_BASE_URL (or WEBSITE_HOSTNAME) is required in production to generate unsubscribe links.');
}

function createEmailUnsubscribeToken(memberId: string, email?: string): string {
  const secret = getTokenSecret();
  const expiryHours = parseExpiryHours(process.env['EMAIL_PREFERENCE_TOKEN_EXPIRY_HOURS'], 24 * 30);

  return jwt.sign(
    {
      type: 'email-unsubscribe',
      memberId,
      ...(email ? { email } : {}),
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: `${expiryHours}h`,
    }
  );
}

function verifyEmailUnsubscribeToken(token: string): VerifiedEmailPreferenceToken {
  const secret = getTokenSecret();
  const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;

  if (payload['type'] !== 'email-unsubscribe') {
    throw new Error('Invalid unsubscribe token.');
  }

  const memberId = typeof payload['memberId'] === 'string' ? payload['memberId'] : '';
  const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;

  if (!memberId) {
    throw new Error('Invalid unsubscribe token payload.');
  }

  return {
    memberId,
    email,
    expiresAt: typeof payload['exp'] === 'number' ? new Date(payload['exp'] * 1000).toISOString() : undefined,
  };
}

function buildMemberEmailUnsubscribeUrl(memberId: string, email?: string): string {
  const token = createEmailUnsubscribeToken(memberId, email);
  const publicApiBaseUrl = getPublicApiBaseUrl();
  return `${publicApiBaseUrl}/api/v1/preferences/email/unsubscribe/${encodeURIComponent(token)}`;
}

export { buildMemberEmailUnsubscribeUrl, createEmailUnsubscribeToken, verifyEmailUnsubscribeToken };
export type { VerifiedEmailPreferenceToken };