import { expect, test, type Frame, type Page, type Request } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const memberUsername = (process.env.PW_MEMBER_USER ?? '').trim();
const memberPassword = (process.env.PW_MEMBER_PASS ?? '').trim();
const authStepMaxAttempts = 18;
const authStepSleepMs = 500;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function scopes(page: Page): Array<Page | Frame> {
  return [page, ...page.frames()];
}

async function fillIfVisible(scope: Page | Frame, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function clickIfVisible(scope: Page | Frame, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
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
      'input[placeholder*="Email"]',
      'input[placeholder*="email"]',
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
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
    ]);

    await sleep(authStepSleepMs);
  }

  return false;
}

async function completePasswordStep(authPage: Page, password: string): Promise<boolean> {
  for (let i = 0; i < authStepMaxAttempts; i += 1) {
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

    await sleep(authStepSleepMs);
  }

  return false;
}

async function loginWithCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${appBaseUrl}/login`, { waitUntil: 'domcontentloaded' });

  const signInButton = page.getByRole('button', { name: /sign in/i });
  await expect(signInButton).toBeVisible({ timeout: 20_000 });

  const popupPromise = page.waitForEvent('popup', { timeout: 12_000 }).catch(() => null);
  await signInButton.click();
  const popup = await popupPromise;
  const authPage = popup ?? page;

  const userFilled = await completeUsernameStep(authPage, username);
  expect(userFilled, 'username input should be reachable in auth flow').toBeTruthy();

  const passFilled = await completePasswordStep(authPage, password);
  expect(passFilled, 'password input should be reachable in auth flow').toBeTruthy();

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

  // After popup auth, the opener can remain on its pre-auth URL depending on browser/MSAL timing.
  // Force navigation to a protected page and then verify we are not bounced back to login.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const onLogin = /\/login(\?|$)/i.test(page.url());
    if (!onLogin) {
      return;
    }
    await sleep(2_500);
  }

  await expect(page).not.toHaveURL(/\/login(\?|$)/i, { timeout: 10_000 });
}

test.describe('Auth Email Hint Regression', () => {
  test.setTimeout(120_000);

  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.skip(!memberUsername || !memberPassword, 'PW_MEMBER_USER and PW_MEMBER_PASS are required.');

  test('sends id token email in X-Id-Token-Email header', async ({ page }) => {
    await loginWithCredentials(page, memberUsername, memberPassword);

    const idTokenEmail = await page.evaluate(() => {
      const keys = Object.keys(window.localStorage);
      const idTokenKey = keys.find((key) => key.toLowerCase().includes('idtoken'));
      if (!idTokenKey) {
        return null;
      }

      try {
        const raw = window.localStorage.getItem(idTokenKey);
        if (!raw) {
          return null;
        }
        const parsed = JSON.parse(raw) as { secret?: string };
        const jwt = parsed.secret;
        if (!jwt || jwt.split('.').length !== 3) {
          return null;
        }

        const payloadPart = jwt.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
        if (!payloadPart) {
          return null;
        }

        const padded = payloadPart + '='.repeat((4 - (payloadPart.length % 4)) % 4);
        const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
        const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
        return email && email.includes('@') ? email : null;
      } catch {
        return null;
      }
    });

    test.skip(!idTokenEmail, 'id_token email claim is required for this regression check.');

    let capturedHeader: string | null = null;
    const onRequest = (request: Request) => {
      if (!request.url().toLowerCase().includes('/api/v1/')) {
        return;
      }

      const value = request.headers()['x-id-token-email'];
      if (typeof value === 'string' && value.trim().length > 0) {
        capturedHeader = value.trim().toLowerCase();
      }
    };

    page.on('request', onRequest);

    await page.goto(`${appBaseUrl}/events`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2_000);

    page.off('request', onRequest);

    expect(capturedHeader, 'frontend should send X-Id-Token-Email on API calls').toBeTruthy();
    expect(capturedHeader).toBe(idTokenEmail);
  });
});
