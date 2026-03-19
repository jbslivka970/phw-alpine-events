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

  const payload = jwt.verify(token, config.tokenSecret, { algorithms: ['HS256'] }) as JwtPayload;
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

function buildMemberRsvpUrls(eventId: string, memberId: string, groupContextId?: string): MemberRsvpUrls {
  const config = loadRsvpLinkConfig();
  if (!config.isConfigured) {
    throw new Error('RSVP links are not configured.');
  }

  const token = createRsvpToken(eventId, memberId, groupContextId);
  const path = `${config.frontendBaseUrl}/rsvp/${encodeURIComponent(token)}`;

  return {
    token,
    landingUrl: path,
    yesUrl: `${path}?response=yes`,
    noUrl: `${path}?response=no`,
    maybeUrl: `${path}?response=maybe`,
    waitlistUrl: `${path}?response=waitlist`,
  };
}

export { buildMemberRsvpUrls, createRsvpToken, verifyRsvpToken };
export type { MemberRsvpUrls, VerifiedRsvpToken };