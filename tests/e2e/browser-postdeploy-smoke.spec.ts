import { expect, test, type Page } from '@playwright/test';
import path from 'path';
import { authenticateWithVariantA } from './helpers/e2eExchangeAuth';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const variantAEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_AUTH_VARIANT_A_ENABLED ?? '');
const memberStatePath = path.join(process.cwd(), 'tests/e2e/.auth/member.json');

async function seedLocalMemberAuth(page: Page): Promise<void> {
  if (!localE2EAuthEnabled) {
    return;
  }

  await page.addInitScript(() => {
    window.localStorage.setItem('phw_e2e_local_auth', '1');
    window.localStorage.setItem('phw_e2e_role', 'USER');
  });
}

async function hasStableDashboardAccess(page: Page): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (page.isClosed()) {
      return false;
    }
    await page.waitForTimeout(3_000);
    if (/\/login(\?|$)/i.test(page.url())) {
      continue;
    }

    return true;
  }

  return false;
}

async function ensureMemberAuthenticatedSession(page: Page): Promise<boolean> {
  if (localE2EAuthEnabled) {
    await seedLocalMemberAuth(page);
    return hasStableDashboardAccess(page);
  }

  if (await authenticateWithVariantA(page, { appBaseUrl, persona: 'member' })) {
    return true;
  }

  if (await hasStableDashboardAccess(page)) {
    return true;
  }

  return false;
}

test.describe('Post-deploy browser smoke (member)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');

  test('dashboard, events RSVP, and TAVF preference flow', async ({ browser }) => {
    test.setTimeout(210_000);

    // Load pre-captured MSAL v5 browser storage state from the refresh job so
    // ensureMemberAuthenticatedSession can skip popup login when tokens are valid.
    const context = await browser.newContext({ storageState: memberStatePath });
    const page = await context.newPage();
    const memberRsvp403s: string[] = [];
    let rsvpCleanup: { eventId: string; memberId: string } | null = null;

    const responseListener = (response: { url(): string; status(): number }) => {
      const url = response.url();
      if (/\/api\/v1\/members\/[^/]+\/rsvps/i.test(url) && response.status() === 403) {
        memberRsvp403s.push(url);
      }
      // Capture RSVP upsert so we can clean up after the test.
      const rsvpMatch = url.match(/\/api\/v1\/events\/([0-9a-f-]{36})\/rsvp$/i);
      if (rsvpMatch && response.status() >= 200 && response.status() < 300) {
        // Attempt to extract memberId from the JSON body asynchronously.
        void (response as import('@playwright/test').Response).json()
          .then((body: { member_id?: string }) => {
            if (rsvpMatch[1] && body?.member_id) {
              rsvpCleanup = { eventId: rsvpMatch[1], memberId: body.member_id };
            }
          })
          .catch(() => {});
      }
    };

    page.on('response', responseListener);

    try {
      const isAuthenticated = await ensureMemberAuthenticatedSession(page);
      expect(isAuthenticated, 'Member session could not be established in this environment for postdeploy member smoke.').toBeTruthy();

      await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      if (/\/login(\?|$)/i.test(page.url())) {
        const recovered = await ensureMemberAuthenticatedSession(page);
        expect(recovered, 'Member session was lost after initial auth; re-auth recovery failed.').toBeTruthy();
        await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      }
      await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 20_000 });
      await page.waitForTimeout(1_200);
      expect(memberRsvp403s, 'dashboard must not receive 403 from /members/:id/rsvps').toHaveLength(0);

      await page.goto(`${appBaseUrl}/events`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: /events/i })).toBeVisible({ timeout: 15_000 });

      const saveButtons = page.getByRole('button', { name: /save rsvp/i });
      const saveCount = await saveButtons.count();
      if (saveCount > 0) {
        await saveButtons.first().click();
        await expect(saveButtons.first()).toHaveText(/saving|save rsvp/i, { timeout: 10_000 });
      }

      await page.goto(`${appBaseUrl}/tavf`, { waitUntil: 'domcontentloaded' });
      const notifyToggle = page.locator('#tavf-notify-toggle');
      await expect(notifyToggle).toBeVisible({ timeout: 15_000 });

      const originalValue = await notifyToggle.isChecked();
      await notifyToggle.click();
      if (localE2EAuthEnabled) {
        await page.waitForTimeout(500);
      } else {
        await expect(notifyToggle).toBeDisabled({ timeout: 5_000 });
        await expect(notifyToggle).toBeEnabled({ timeout: 20_000 });
      }

      const afterFirstToggle = await notifyToggle.isChecked();

      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloadedToggle = page.locator('#tavf-notify-toggle');
      await expect(reloadedToggle).toBeVisible({ timeout: 15_000 });
      if (!localE2EAuthEnabled) {
        await expect(reloadedToggle).toBeChecked({ checked: afterFirstToggle, timeout: 20_000 });
      }

      await reloadedToggle.click();
      if (!localE2EAuthEnabled) {
        await expect(reloadedToggle).toBeDisabled({ timeout: 5_000 });
        await expect(reloadedToggle).toBeEnabled({ timeout: 20_000 });
      }
    } finally {
      page.off('response', responseListener);

      // Clean up any RSVP that was saved during this test run.
      if (rsvpCleanup) {
        const { eventId, memberId } = rsvpCleanup;
        const apiBase = (process.env.E2E_API_URL ?? appBaseUrl.replace(/\/+$/, '')).replace(/\/+$/, '');
        await page.request.delete(`${apiBase}/api/v1/events/${eventId}/rsvp/${memberId}`)
          .catch((err: unknown) => {
            console.warn('[smoke] RSVP cleanup failed (non-fatal):', err);
          });
      }

      await context.close().catch(() => {});
    }
  });
});
