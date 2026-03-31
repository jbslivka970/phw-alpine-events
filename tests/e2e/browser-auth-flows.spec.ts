import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const authDir = path.resolve(process.cwd(), 'tests/e2e/.auth');
const creatorState = path.join(authDir, 'event-creator.json');
const memberState = path.join(authDir, 'member.json');

test.describe('Browser role flows (authenticated storage state)', () => {
  test.describe('Event creator', () => {
    test('notification preferences loads without member-id GUID failures', async ({ browser }) => {
      test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
      test.skip(!fs.existsSync(creatorState), 'event creator storage state is required. Run e2e:refresh-tokens first.');

      const context = await browser.newContext({ storageState: creatorState });
      const page = await context.newPage();

      await page.goto(`${appBaseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: /notification preferences/i })).toBeVisible();
      await expect(page.getByText(/invalid guid/i)).toHaveCount(0);
      await expect(page.getByText(/api 500/i)).toHaveCount(0);

      await context.close();
    });

    test('can open TAVF new-posting route and submit posting', async ({ browser }) => {
      test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
      test.skip(!fs.existsSync(creatorState), 'event creator storage state is required. Run e2e:refresh-tokens first.');

      const context = await browser.newContext({ storageState: creatorState });
      const page = await context.newPage();

      await page.goto(`${appBaseUrl}/tavf/new`, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/tavf\/new(\?|$)/);

      const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await page.locator('#event-date').fill(eventDate);
      await page.locator('#location').fill('Playwright Auth Flow River');
      await page.locator('#capacity').fill('1');
      await page.locator('#species').fill('Trout');
      await page.getByRole('button', { name: /create posting/i }).click();

      await expect(page).toHaveURL(/\/tavf\/.+/);
      await expect(page.getByText(/internal server error/i)).toHaveCount(0);

      await context.close();
    });
  });

  test.describe('Member', () => {
    test('can access preferences route with authenticated storage state', async ({ browser }) => {
      test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
      test.skip(!fs.existsSync(memberState), 'member storage state is required. Run e2e:refresh-tokens first.');

      const context = await browser.newContext({ storageState: memberState });
      const page = await context.newPage();

      await page.goto(`${appBaseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: /notification preferences/i })).toBeVisible();
      await expect(page.getByText(/insufficient permissions/i)).toHaveCount(0);
      await expect(page.getByText(/invalid guid/i)).toHaveCount(0);

      await context.close();
    });
  });
});
