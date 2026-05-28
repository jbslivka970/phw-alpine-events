import { expect, test, type Frame, type Page, type Request } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const memberUsername = (process.env.PW_MEMBER_USER ?? '').trim();
const memberPassword = (process.env.PW_MEMBER_PASS ?? '').trim();
const memberStatePath = 'tests/e2e/.auth/member.json';
const authStepMaxAttempts = 60;
const authStepSleepMs = 800;
const headerSafeAsciiRegex = /^[\x20-\x7e]+$/;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEmailHintValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isSyntheticTenantPrincipalEmail(value: string): boolean {
  return /#ext#@/i.test(value);
}

function isHeaderSafeAscii(value: string): boolean {
  return headerSafeAsciiRegex.test(value);
}

function isUsableEmailHint(value: string | null): value is string {
  return Boolean(
    value
    && value.includes('@')
    && !isSyntheticTenantPrincipalEmail(value)
    && isHeaderSafeAscii(value),
  );
}

function firstNormalizedEmailValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = normalizeEmailHintValue(value);
    return isUsableEmailHint(normalized) ? normalized : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = firstNormalizedEmailValue(entry);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function resolveExpectedEmailHint(claims: Record<string, unknown>, fallbackUsername: string): string | null {
  for (const key of ['email', 'preferred_username', 'upn', 'emails', 'otherMails']) {
    const resolved = firstNormalizedEmailValue(claims[key]);
    if (resolved) {
      return resolved;
    }
  }

  const signInNames = claims.signInNames;
  if (signInNames && typeof signInNames === 'object') {
    const emailAddress = firstNormalizedEmailValue((signInNames as Record<string, unknown>).emailAddress);
    if (emailAddress) {
      return emailAddress;
    }
  }

  for (const [key, value] of Object.entries(claims)) {
    if (!/email/i.test(key)) {
      continue;
    }

    const resolved = firstNormalizedEmailValue(value);
    if (resolved) {
      return resolved;
    }
  }

  const fallback = normalizeEmailHintValue(fallbackUsername);
  return isUsableEmailHint(fallback) ? fallback : null;
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
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  for (let i = 0; i < authStepMaxAttempts; i += 1) {
    await clickInAnyScope(authPage, [
      'a:has-text("Use password")',
      'button:has-text("Use password")',
      'a:has-text("Use your password")',
      'button:has-text("Use your password")',
      'a:has-text("Sign in with a password")',
      'button:has-text("Sign in with a password")',
      'a:has-text("Sign-in options")',
      'button:has-text("Sign-in options")',
      'a:has-text("Other ways to sign in")',
      'button:has-text("Other ways to sign in")',
      'a:has-text("Try another way")',
      'button:has-text("Try another way")',
      'a:has-text("Use a different sign-in method")',
      'button:has-text("Use a different sign-in method")',
      'a:has-text("Sign in another way")',
      'button:has-text("Sign in another way")',
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

  // Give CIAM time to transition from the username/next screen to the password screen.
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(2_000);

  const passFilled = await completePasswordStep(authPage, password);

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
      await sleep(2_500);
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
  test.use({ storageState: memberStatePath });

  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');

  test('sends id token email in X-Id-Token-Email header', async ({ page }) => {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});

    if (/\/login(\?|$)/i.test(page.url())) {
      if (!memberUsername || !memberPassword) {
        throw new Error('member storage state is unauthenticated and PW_MEMBER_USER/PW_MEMBER_PASS fallback credentials are not configured.');
      }

      await loginWithCredentials(page, memberUsername, memberPassword);
    }

    await expect(page).not.toHaveURL(/\/login(\?|$)/i, { timeout: 15_000 });

    const idTokenClaims = await page.evaluate(() => {
      const keys = Object.keys(window.localStorage);
      const idTokenKeys = keys.filter((key) => key.toLowerCase().includes('idtoken'));
      if (idTokenKeys.length === 0) {
        return null;
      }

      for (const idTokenKey of idTokenKeys) {
        try {
          const raw = window.localStorage.getItem(idTokenKey);
          if (!raw) {
            continue;
          }

          const parsed = JSON.parse(raw) as { secret?: string };
          const jwt = parsed.secret;
          if (!jwt || jwt.split('.').length !== 3) {
            continue;
          }

          const payloadPart = jwt.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
          if (!payloadPart) {
            continue;
          }

          const padded = payloadPart + '='.repeat((4 - (payloadPart.length % 4)) % 4);
          return JSON.parse(atob(padded)) as Record<string, unknown>;
        } catch {
          // Try the next id_token entry if this one cannot be decoded.
        }
      }

      return null;
    });

    const expectedEmailHint = resolveExpectedEmailHint(idTokenClaims ?? {}, memberUsername);
    expect(expectedEmailHint, 'a usable email hint should be derivable from id_token claims or member username fallback.').toBeTruthy();
    const expectedHeaderValue = expectedEmailHint as string;

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
    expect(capturedHeader).toBe(expectedHeaderValue);
  });
});
