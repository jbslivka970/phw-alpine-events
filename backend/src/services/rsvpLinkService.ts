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
  const path = `${config.frontendBaseUrl}/rsvp/${encodeURIComponent(token)}`;

  const createPresetUrl = (response: 'yes' | 'no' | 'maybe' | 'waitlist'): string => {
    const params = new URLSearchParams({ response });
    if (preferredRole) {
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

export { buildMemberRsvpUrls, createRsvpToken, verifyRsvpToken };
export type { MemberRsvpUrls, VerifiedRsvpToken, ResponseRole };