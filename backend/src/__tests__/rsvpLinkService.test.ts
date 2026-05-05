import jwt from 'jsonwebtoken';
import { buildMemberRsvpUrls, createRsvpToken, verifyRsvpToken } from '../services/rsvpLinkService';

describe('rsvpLinkService', () => {
  beforeEach(() => {
    process.env['FRONTEND_APP_URL'] = 'https://app.test.example';
    process.env['RSVP_TOKEN_SECRET'] = 'test-rsvp-secret';
    process.env['RSVP_TOKEN_EXPIRY_HOURS'] = '168';
  });

  it('builds one-click links with default participant role when role is not provided', () => {
    const urls = buildMemberRsvpUrls(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );
    const pathToken = urls.landingUrl.split('/rsvp/')[1] ?? '';

    expect(urls.landingUrl).toContain('https://app.test.example/rsvp/');
    expect(urls.yesUrl).toContain('/rsvp/');
    expect(urls.yesUrl).toContain('?response=yes&role=PARTICIPANT');
    expect(urls.waitlistUrl).toContain('?response=waitlist&role=PARTICIPANT');
    expect(urls.noUrl).toContain('?response=no');
    expect(pathToken).not.toContain('.');
    expect(pathToken.length).toBeLessThan(120);
    expect(urls.yesUrl).not.toContain('/api/v1/events/rsvp/');
    expect(urls.yesUrl).not.toContain('/respond?');
    expect(verifyRsvpToken(pathToken).eventId).toBe('00000000-0000-0000-0000-000000000101');
  });

  it('builds role-aware one-click links when preferred role is provided', () => {
    const urls = buildMemberRsvpUrls(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202',
      '00000000-0000-0000-0000-000000000303',
      'MENTOR'
    );

    expect(urls.yesUrl).toContain('?response=yes&role=MENTOR');
    expect(urls.noUrl).toContain('?response=no&role=MENTOR');
    expect(urls.maybeUrl).toContain('?response=maybe&role=MENTOR');
    expect(urls.waitlistUrl).toContain('?response=waitlist&role=MENTOR');
  });

  it('verifies tokens with trailing punctuation from copied links', () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    const verified = verifyRsvpToken(`${token}.`);
    expect(verified.eventId).toBe('00000000-0000-0000-0000-000000000101');
    expect(verified.memberId).toBe('00000000-0000-0000-0000-000000000202');
  });

  it('verifies percent-encoded tokens from path-based links', () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    const verified = verifyRsvpToken(encodeURIComponent(token));
    expect(verified.eventId).toBe('00000000-0000-0000-0000-000000000101');
    expect(verified.memberId).toBe('00000000-0000-0000-0000-000000000202');
  });

  it('verifies tokens extracted from wrapped link text noise', () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    const wrapped = `Open this link: <https://example.test/rsvp/${token}>`;
    const verified = verifyRsvpToken(wrapped);

    expect(verified.eventId).toBe('00000000-0000-0000-0000-000000000101');
    expect(verified.memberId).toBe('00000000-0000-0000-0000-000000000202');
  });

  it('verifies base64url-wrapped tokens extracted from public RSVP URLs', () => {
    const legacyJwt = jwt.sign(
      {
        type: 'event-rsvp',
        eventId: '00000000-0000-0000-0000-000000000101',
        memberId: '00000000-0000-0000-0000-000000000202',
      },
      process.env['RSVP_TOKEN_SECRET'] as string,
      {
        algorithm: 'HS256',
        expiresIn: '168h',
      }
    );
    const legacyWrappedToken = Buffer.from(legacyJwt, 'utf8').toString('base64url');

    const verified = verifyRsvpToken(`Open this link: <https://example.test/rsvp/${legacyWrappedToken}>`);

    expect(verified.eventId).toBe('00000000-0000-0000-0000-000000000101');
    expect(verified.memberId).toBe('00000000-0000-0000-0000-000000000202');
  });

  it('verifies compact tokens extracted from wrapped public RSVP URLs', () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    const verified = verifyRsvpToken(`Open this link: <https://example.test/rsvp/${token}>`);

    expect(verified.eventId).toBe('00000000-0000-0000-0000-000000000101');
    expect(verified.memberId).toBe('00000000-0000-0000-0000-000000000202');
  });
});
