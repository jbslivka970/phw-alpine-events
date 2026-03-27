import { buildMemberRsvpUrls } from '../services/rsvpLinkService';

describe('rsvpLinkService', () => {
  it('builds one-click links without role when role is not provided', () => {
    const urls = buildMemberRsvpUrls(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    expect(urls.yesUrl).toContain('?response=yes');
    expect(urls.yesUrl).not.toContain('role=');
    expect(urls.waitlistUrl).toContain('?response=waitlist');
    expect(urls.waitlistUrl).not.toContain('role=');
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
});
