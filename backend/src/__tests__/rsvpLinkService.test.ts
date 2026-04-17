import { buildMemberRsvpUrls, createRsvpToken, verifyRsvpToken } from '../services/rsvpLinkService';

describe('rsvpLinkService', () => {
  beforeEach(() => {
    process.env['FRONTEND_APP_URL'] = 'https://app.test.example';
  });

  it('builds one-click links with default participant role when role is not provided', () => {
    const urls = buildMemberRsvpUrls(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    expect(urls.landingUrl).toContain('https://app.test.example/rsvp/');
    expect(urls.yesUrl).toContain('/rsvp/');
    expect(urls.yesUrl).toContain('?response=yes&role=PARTICIPANT');
    expect(urls.waitlistUrl).toContain('?response=waitlist&role=PARTICIPANT');
    expect(urls.noUrl).toContain('?response=no');
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
});
