import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const memberStatePath = path.resolve(process.cwd(), 'tests/e2e/.auth/member.json');
const memberUsername = (process.env.PW_MEMBER_USER ?? '').trim();
const memberPassword = (process.env.PW_MEMBER_PASS ?? '').trim();

function scopes(page: Page): Array<Page | Frame> {
  return [page, ...page.frames()];
}

async function fillIfVisible(page: Page | Frame, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function clickIfVisible(page: Page | Frame, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function fillInAnyScope(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const scope of scopes(page)) {
    if (await fillIfVisible(scope, selectors, value)) {
      return true;
    }
  }
  return false;
}

async function clickInAnyScope(page: Page, selectors: string[]): Promise<boolean> {
  for (const scope of scopes(page)) {
    if (await clickIfVisible(scope, selectors)) {
      return true;
    }
  }
  return false;
}

async function completeUsernameStep(authPage: Page, username: string): Promise<boolean> {
  for (let i = 0; i < 45; i += 1) {
    await clickInAnyScope(authPage, [
      `text="${username}"`,
      `[data-test-id="${username}"]`,
      '[data-test-id="displayName"]',
      'div[role="button"]:has-text("Use another account")',
      'div[role="button"]:has-text("Sign in")',
    ]);

    const entered = await fillInAnyScope(authPage, [
      'input[type="email"]',
      'input[type="text"]',
      'input[name="loginfmt"]',
      'input[name="identifier"]',
      'input#i0116',
      'input[name="signInName"]',
      'input#username',
      'input[placeholder*="Email"]',
      'input[placeholder*="email"]',
      'input[placeholder*="phone"]',
    ], username);

    if (entered) {
      await clickInAnyScope(authPage, [
        'button:has-text("Next")',
        'input[type="submit"]#idSIButton9',
        'button[type="submit"]',
      ]);
      return true;
    }

    await clickInAnyScope(authPage, [
      'button:has-text("Use another account")',
      'a:has-text("Use another account")',
      'div:has-text("Use another account")',
      'button:has-text("Sign in")',
      'button:has-text("Sign in with Microsoft")',
      'button:has-text("Continue")',
      'a:has-text("Continue")',
    ]);

    await authPage.waitForTimeout(800);
  }

  return false;
}

async function completePasswordStep(authPage: Page, password: string): Promise<boolean> {
  for (let i = 0; i < 45; i += 1) {
    await clickInAnyScope(authPage, [
      'a:has-text("Use password")',
      'button:has-text("Use password")',
      'a:has-text("Sign-in options")',
      'button:has-text("Sign-in options")',
      'a:has-text("Other ways to sign in")',
      'button:has-text("Other ways to sign in")',
    ]);

    const entered = await fillInAnyScope(authPage, [
      'input[type="password"]',
      'input[name="passwd"]',
      'input#i0118',
      'input[name="password"]',
    ], password);

    if (entered) {
      await clickInAnyScope(authPage, [
        'button:has-text("Sign in")',
        'button:has-text("Continue")',
        'input[type="submit"]#idSIButton9',
        'button[type="submit"]',
      ]);
      return true;
    }

    await authPage.waitForTimeout(800);
  }

  return false;
}

async function loginWithCredentials(page: Page): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(`${appBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
      const onIdentityProvider = () => /login\.microsoftonline\.com|b2clogin\.com|ciamlogin\.com/i.test(page.url());
      const signInButton = page.getByRole('button', { name: /sign in/i });
      let popup: Page | null = null;

      if (!onIdentityProvider()) {
        await signInButton.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => null);
        if (await signInButton.isVisible().catch(() => false)) {
          const popupPromise = page.waitForEvent('popup', { timeout: 12_000 }).catch(() => null);
          await signInButton.click();
          popup = await popupPromise;
        } else {
          await clickInAnyScope(page, [
            'button:has-text("Sign in")',
            'button:has-text("Continue")',
            'a:has-text("Sign in")',
            'a:has-text("Continue")',
          ]);
          await page.waitForTimeout(1_500);
        }
      }

      const authPage = popup ?? page;

      await authPage.waitForLoadState('domcontentloaded').catch(() => {});
      const userFilled = await completeUsernameStep(authPage, memberUsername);
      expect(userFilled, 'username input should be reachable in auth flow').toBeTruthy();

      await authPage.waitForLoadState('domcontentloaded').catch(() => {});
      const passFilled = await completePasswordStep(authPage, memberPassword);
      expect(passFilled, 'password input should be reachable in auth flow').toBeTruthy();

      await authPage.waitForLoadState('domcontentloaded').catch(() => {});
      await clickInAnyScope(authPage, [
        'button:has-text("No")',
        'button:has-text("Yes")',
        'button:has-text("Accept")',
        'button:has-text("Continue")',
        'input[type="submit"]#idSIButton9',
        'button[type="submit"]',
      ]);

      if (popup) {
        await popup.waitForEvent('close', { timeout: 90_000 }).catch(() => {});
      }

      for (let authAttempt = 1; authAttempt <= 3; authAttempt += 1) {
        await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
        const onLogin = /\/login(\?|$)/i.test(page.url());
        if (!onLogin) {
          return;
        }
        await page.waitForTimeout(2_500);
      }

      await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await page.context().clearCookies().catch(() => {});
      await page.goto('about:blank').catch(() => {});
    }
  }

  throw lastError ?? new Error('Failed to log in with credentials.');
}

test.describe('Post-deploy browser smoke (member)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');

  test('dashboard, events RSVP, and TAVF preference flow', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(!fs.existsSync(memberStatePath) && (!memberUsername || !memberPassword), 'Member storage state or PW_MEMBER_USER/PW_MEMBER_PASS are required.');

    const context = fs.existsSync(memberStatePath)
      ? await browser.newContext({ storageState: memberStatePath })
      : await browser.newContext();
    const page = await context.newPage();
    const memberRsvp403s: string[] = [];

    const responseListener = (response: { url(): string; status(): number }) => {
      const url = response.url();
      if (/\/api\/v1\/members\/[^/]+\/rsvps/i.test(url) && response.status() === 403) {
        memberRsvp403s.push(url);
      }
    };

    page.on('response', responseListener);

    try {
      if (!fs.existsSync(memberStatePath)) {
        await loginWithCredentials(page);
      }

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
      await context.close().catch(() => {});
    }
  });
});
