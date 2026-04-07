import jwt, { JwtPayload } from 'jsonwebtoken';
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

  throw new Error('PUBLIC_API_BASE_URL (or WEBSITE_HOSTNAME) is required in production to generate RSVP action links.');
}

function createRsvpToken(eventId: string, memberId: string, groupContextId?: string): string {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    throw new Error('RSVP links are not configured.');
  }

  return jwt.sign(
    {
      type: 'event-rsvp',
      eventId,
      memberId,
      ...(groupContextId ? { groupContextId } : {}),
    },
    config.tokenSecret,
    {
      algorithm: 'HS256',
      expiresIn: `${config.tokenExpiryHours}h`,
    }
  );
}

function verifyRsvpToken(token: string): VerifiedRsvpToken {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    throw new Error('RSVP links are not configured.');
  }

  const normalizedToken = normalizeIncomingToken(token);
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

function normalizeIncomingToken(rawToken: string): string {
  let token = String(rawToken ?? '').trim();

  // Some SMS/email clients include link wrappers or punctuation when copied/opened.
  token = token
    .replace(/^['"“”`(\[]+/, '')
    .replace(/[\s'"“”`)\].,;!?]+$/g, '');

  // Decode percent-encoded variants safely (at most twice to avoid over-decoding).
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(token);
      if (decoded === token) {
        break;
      }
      token = decoded;
    } catch {
      break;
    }
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
  const encodedToken = encodeURIComponent(token);
  const path = `${config.frontendBaseUrl}/rsvp/${encodedToken}`;
  const actionPath = `${getPublicApiBaseUrl()}/api/v1/events/rsvp/${encodedToken}/respond`;

  const createPresetUrl = (response: 'yes' | 'no' | 'maybe' | 'waitlist'): string => {
    const params = new URLSearchParams({ response });
    if (response === 'yes' || response === 'maybe' || response === 'waitlist') {
      params.set('role', preferredRole ?? 'PARTICIPANT');
    } else if (preferredRole) {
      params.set('role', preferredRole);
    }
    return `${actionPath}?${params.toString()}`;
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

export { buildMemberRsvpUrls, createRsvpToken, verifyRsvpToken };
export type { MemberRsvpUrls, VerifiedRsvpToken, ResponseRole };