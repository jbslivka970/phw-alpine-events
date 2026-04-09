import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const memberStatePath = path.resolve(process.cwd(), 'tests/e2e/.auth/member.json');

test.describe('Post-deploy browser smoke (member)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.skip(!fs.existsSync(memberStatePath), 'Member storage state is required. Run e2e:refresh-tokens first.');
  test.use({ storageState: memberStatePath });

  test('dashboard, events RSVP, and TAVF preference flow', async ({ page }) => {
    const memberRsvp403s: string[] = [];

    const responseListener = (response: { url(): string; status(): number }) => {
      const url = response.url();
      if (/\/api\/v1\/members\/[^/]+\/rsvps/i.test(url) && response.status() === 403) {
        memberRsvp403s.push(url);
      }
    };

    page.on('response', responseListener);

    try {
      await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
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
      await expect(notifyToggle).toBeDisabled({ timeout: 5_000 });
      await expect(notifyToggle).toBeEnabled({ timeout: 20_000 });
      await expect(notifyToggle).toBeChecked({ checked: !originalValue, timeout: 20_000 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloadedToggle = page.locator('#tavf-notify-toggle');
      await expect(reloadedToggle).toBeVisible({ timeout: 15_000 });
      await expect(reloadedToggle).toBeChecked({ checked: !originalValue, timeout: 20_000 });

      await reloadedToggle.click();
      await expect(reloadedToggle).toBeDisabled({ timeout: 5_000 });
      await expect(reloadedToggle).toBeEnabled({ timeout: 20_000 });
      await expect(reloadedToggle).toBeChecked({ checked: originalValue, timeout: 20_000 });
    } finally {
      page.off('response', responseListener);
    }
  });
});
