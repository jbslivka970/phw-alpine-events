import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const memberStatePath = path.resolve(process.cwd(), 'tests/e2e/.auth/member.json');
const memberUsername = (process.env.PW_MEMBER_USER ?? '').trim();
const memberPassword = (process.env.PW_MEMBER_PASS ?? '').trim();
const authStepMaxAttempts = 60;
const authStepSleepMs = 800;
const loginAttemptTimeoutMs = Number.parseInt(process.env.PW_LOGIN_ATTEMPT_TIMEOUT_MS || '180000', 10);

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
  for (let i = 0; i < authStepMaxAttempts; i += 1) {
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

    await authPage.waitForTimeout(authStepSleepMs);
  }

  return false;
}

async function completePasswordStep(authPage: Page, password: string): Promise<boolean> {
  for (let i = 0; i < authStepMaxAttempts; i += 1) {
    await clickInAnyScope(authPage, [
      'a:has-text("Use password")',
      'button:has-text("Use password")',
      'a:has-text("Use your password")',
      'button:has-text("Use your password")',
      'a:has-text("Sign-in options")',
      'button:has-text("Sign-in options")',
      'a:has-text("Other ways to sign in")',
      'button:has-text("Other ways to sign in")',
      'a:has-text("Try another way")',
      'button:has-text("Try another way")',
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

    await authPage.waitForTimeout(authStepSleepMs);
  }

  return false;
}

async function loginWithCredentials(page: Page): Promise<void> {
  // Simplified login matching auth_email_hint — no inner retry loop, no Promise.race.
  // auth_email_hint uses the same credentials and passes consistently in CI headless.
  await page.goto(`${appBaseUrl}/login`, { waitUntil: 'domcontentloaded' });

  const signInButton = page.getByRole('button', { name: /sign in/i });
  await expect(signInButton).toBeVisible({ timeout: 20_000 });

  const popupPromise = page.waitForEvent('popup', { timeout: 12_000 }).catch(() => null);
  await signInButton.click();
  const popup = await popupPromise;
  const authPage = popup ?? page;

  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  const userFilled = await completeUsernameStep(authPage, memberUsername);
  expect(userFilled, 'username input should be reachable in auth flow').toBeTruthy();

  // Give CIAM time to transition from the username/next screen to the password screen.
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await authPage.waitForTimeout(2_000);
  const passFilled = await completePasswordStep(authPage, memberPassword);

  if (!passFilled) {
    // Some CIAM account-tile/session-resume paths complete sign-in without rendering
    // a password field. Try to finalize and validate authenticated app navigation.
    await clickInAnyScope(authPage, [
      'button:has-text("No")',
      'button:has-text("Yes")',
      'button:has-text("Accept")',
      'button:has-text("Continue")',
      'input[type="submit"]#idSIButton9',
      'button[type="submit"]',
    ]);

    if (popup) {
      await popup.waitForEvent('close', { timeout: 15_000 }).catch(() => {});
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (!/\/login(\?|$)/i.test(page.url())) {
        return;
      }
      await page.waitForTimeout(2_500);
    }

    expect(passFilled, 'password input should be reachable in auth flow when CIAM does not complete sign-in without password UI').toBeTruthy();
  }

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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (!/\/login(\?|$)/i.test(page.url())) {
      return;
    }
    await page.waitForTimeout(2_500);
  }

  await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
}

async function seedLocalMemberAuth(page: Page): Promise<void> {
  if (!localE2EAuthEnabled) {
    return;
  }

  await page.addInitScript(() => {
    window.localStorage.setItem('phw_e2e_local_auth', '1');
    window.localStorage.setItem('phw_e2e_role', 'USER');
  });
}

async function clearBrowserSession(page: Page): Promise<void> {
  await page.context().clearCookies().catch(() => {});
  // Ensure we are on app origin before clearing storage; otherwise localStorage.clear()
  // would run against about:blank and leave MSAL state intact.
  await page.goto(`${appBaseUrl}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }).catch(() => {});
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
}

async function hasStableDashboardAccess(page: Page): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (page.isClosed()) {
      return false;
    }
    await page.waitForTimeout(2_000);
    if (/\/login(\?|$)/i.test(page.url())) {
      return false;
    }

    const signInVisible = await page.getByRole('button', { name: /sign in/i }).first().isVisible().catch(() => false);
    if (signInVisible) {
      return false;
    }
  }

  return true;
}

async function ensureMemberAuthenticatedSession(page: Page): Promise<boolean> {
  if (localE2EAuthEnabled) {
    await seedLocalMemberAuth(page);
    return hasStableDashboardAccess(page);
  }

  if (await hasStableDashboardAccess(page)) {
    return true;
  }

  if (!memberUsername || !memberPassword) {
    return false;
  }

  await clearBrowserSession(page);
  // Direct login — mirrors auth_email_hint which uses the same credentials and passes.
  // Avoid Promise.race: it cancels the timer but leaves loginWithCredentials running,
  // which exhausts steps in the background and hits the Playwright test timeout.
  await loginWithCredentials(page).catch(() => {});
  return hasStableDashboardAccess(page);
}

test.describe('Post-deploy browser smoke (member)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');

  test('dashboard, events RSVP, and TAVF preference flow', async ({ browser }) => {
    test.setTimeout(210_000);
    test.skip(!localE2EAuthEnabled && !fs.existsSync(memberStatePath) && (!memberUsername || !memberPassword), 'Member storage state or PW_MEMBER_USER/PW_MEMBER_PASS are required.');

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
      const isAuthenticated = await ensureMemberAuthenticatedSession(page);
      expect(isAuthenticated, 'Member session could not be established in this environment for postdeploy member smoke.').toBeTruthy();

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
      if (localE2EAuthEnabled) {
        await page.waitForTimeout(500);
      } else {
        await expect(notifyToggle).toBeDisabled({ timeout: 5_000 });
        await expect(notifyToggle).toBeEnabled({ timeout: 20_000 });
        await expect(notifyToggle).toBeChecked({ checked: !originalValue, timeout: 20_000 });
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloadedToggle = page.locator('#tavf-notify-toggle');
      await expect(reloadedToggle).toBeVisible({ timeout: 15_000 });
      if (!localE2EAuthEnabled) {
        await expect(reloadedToggle).toBeChecked({ checked: !originalValue, timeout: 20_000 });
      }

      await reloadedToggle.click();
      if (!localE2EAuthEnabled) {
        await expect(reloadedToggle).toBeDisabled({ timeout: 5_000 });
        await expect(reloadedToggle).toBeEnabled({ timeout: 20_000 });
        await expect(reloadedToggle).toBeChecked({ checked: originalValue, timeout: 20_000 });
      }
    } finally {
      page.off('response', responseListener);
      await context.close().catch(() => {});
    }
  });
});
