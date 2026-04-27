import { expect, test, type Page } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const authStepMaxAttempts = 30;
const authStepSleepMs = 800;
const authSessionAttempts = 2;

type BrowserAccount = {
  label: string;
  username: string;
  password: string;
  statePath: string;
};

const accounts: BrowserAccount[] = [
  {
    label: 'event_creator',
    username: process.env.PW_EVENT_CREATOR_USER ?? '',
    password: process.env.PW_EVENT_CREATOR_PASS ?? '',
    statePath: 'tests/e2e/.auth/event-creator.json',
  },
  {
    label: 'member',
    username: process.env.PW_MEMBER_USER ?? '',
    password: process.env.PW_MEMBER_PASS ?? '',
    statePath: 'tests/e2e/.auth/member.json',
  },
];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function scopes(page: Page) {
  return [page, ...page.frames()];
}

async function fillIfVisible(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function clickIfVisible(page: Page, selectors: string[]): Promise<boolean> {
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
    if (await fillIfVisible(scope as unknown as Page, selectors, value)) {
      return true;
    }
  }
  return false;
}

async function clickInAnyScope(page: Page, selectors: string[]): Promise<boolean> {
  for (const scope of scopes(page)) {
    if (await clickIfVisible(scope as unknown as Page, selectors)) {
      return true;
    }
  }
  return false;
}

async function completeUsernameStep(authPage: Page, username: string): Promise<boolean> {
  for (let i = 0; i < authStepMaxAttempts; i += 1) {
      // Try clicking an account tile for the exact username first (handles account-chooser UI)
      await clickInAnyScope(authPage, [
        `text="${username}"`,
        `[data-test-id="${username}"]`,
        'div[role="button"]:has-text("Use another account")',
      ]);

      const entered = await fillInAnyScope(
      authPage,
      [
        'input[type="email"]',
        'input[name="loginfmt"]',
        'input#i0116',
        'input[name="signInName"]',
        'input[placeholder*="Email"]',
      ],
      username
    );

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

    const entered = await fillInAnyScope(
      authPage,
      ['input[type="password"]', 'input[name="passwd"]', 'input#i0118', 'input[name="password"]'],
      password
    );

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

async function loginWithCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${appBaseUrl}/login`, { waitUntil: 'domcontentloaded' });

  const signInButton = page.getByRole('button', { name: /sign in/i });
  await expect(signInButton).toBeVisible({ timeout: 15_000 });

  const popupPromise = page.waitForEvent('popup', { timeout: 12_000 }).catch(() => null);
  await signInButton.click();
  const popup = await popupPromise;
  const authPage = popup ?? page;

  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  const userFilled = await completeUsernameStep(authPage, username);
  expect(userFilled, 'username input should be reachable in auth flow').toBeTruthy();

  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await authPage.waitForTimeout(2_000);
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
      await page.waitForTimeout(2_500);
    }

    expect(passFilled, 'password input should be reachable in auth flow when CIAM does not complete sign-in without password UI').toBeTruthy();
  }

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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const onLogin = /\/login(\?|$)/i.test(page.url());
    if (!onLogin) {
      return;
    }
    await page.waitForTimeout(2_500);
  }

  await expect(page).not.toHaveURL(/\/login(\?|$)/i, { timeout: 10_000 });
}

async function hasAdminRoleInSession(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const keys = Object.keys(window.sessionStorage).filter((key) => key.includes('msal') && key.includes('account'));
    const roleValues: string[] = [];

    for (const key of keys) {
      try {
        const parsed = JSON.parse(window.sessionStorage.getItem(key) ?? '{}');
        const claims = parsed?.idTokenClaims ?? {};
        const candidates = [claims.roles, claims.role, claims.extension_Roles, claims.extension_roles, claims.app_roles, claims.appRoles];
        for (const candidate of candidates) {
          if (typeof candidate === 'string') {
            roleValues.push(candidate);
          } else if (Array.isArray(candidate)) {
            for (const role of candidate) {
              if (typeof role === 'string') {
                roleValues.push(role);
              }
            }
          }
        }
      } catch {
        // Ignore malformed entries.
      }
    }

    return roleValues.some((role) => role.trim().toUpperCase().replace(/[\s-]+/g, '_') === 'ADMIN');
  });
}

async function seedLocalAuthRole(page: Page, accountLabel: string): Promise<void> {
  if (!localE2EAuthEnabled) {
    return;
  }

  const roleValue = accountLabel === 'event_creator' ? 'EVENT_CREATOR' : 'USER';
  await page.addInitScript(({ role }) => {
    window.localStorage.setItem('phw_e2e_local_auth', '1');
    window.localStorage.setItem('phw_e2e_role', role);
  }, { role: roleValue });
}

async function appearsAuthenticated(page: Page): Promise<boolean> {
  await page.waitForTimeout(1200);
  return !/\/login(\?|$)/i.test(page.url());
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

async function ensureAuthenticatedSession(page: Page, account: BrowserAccount): Promise<boolean> {
  if (localE2EAuthEnabled) {
    await seedLocalAuthRole(page, account.label);
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    return appearsAuthenticated(page);
  }

  await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await appearsAuthenticated(page)) {
    return true;
  }

  if (!account.username || !account.password) {
    return false;
  }

  for (let attempt = 1; attempt <= authSessionAttempts; attempt += 1) {
    await clearBrowserSession(page);
    try {
      await loginWithCredentials(page, account.username, account.password);
      for (let verifyAttempt = 1; verifyAttempt <= 3; verifyAttempt += 1) {
        if (await appearsAuthenticated(page)) {
          return true;
        }
        await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2_500);
      }
    } catch {
      // Continue to one more retry because CIAM UI can be transient in headless CI.
    }
  }

  return false;
}

test.describe('Browser role flows (credential login)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.setTimeout(300_000);

  for (const account of accounts) {
    test.describe(account.label, () => {
      // Note: storageState loading disabled. Browser tests fall back to credential login
      // via ensureAuthenticatedSession(), which is the reliable auth path for deployed environments.
      // test.use({ storageState: account.statePath });

      test.skip(!localE2EAuthEnabled && (!account.username || !account.password), `${account.label} credentials are required when local auth is disabled.`);

      test('preferences page loads without GUID/500 errors', async ({ page }) => {

        const memberDetailIds: string[] = [];
        const nonUuidMemberDetailIds: string[] = [];
        const invalidGuidErrors: string[] = [];

        const responseListener = async (response: { url(): string; status(): number; text(): Promise<string> }) => {
          const url = response.url();
          const match = url.match(/\/api\/v1\/members\/([^/?#]+)/i);
          if (!match) {
            return;
          }

          const memberId = match[1];
          memberDetailIds.push(memberId);

          if (!uuidPattern.test(memberId)) {
            nonUuidMemberDetailIds.push(memberId);
          }

          if (response.status() === 400) {
            const bodyText = (await response.text().catch(() => '')).toLowerCase();
            if (bodyText.includes('invalid guid')) {
              invalidGuidErrors.push(bodyText);
            }
          }
        };

        page.on('response', responseListener);
        try {
          const isAuthenticated = await ensureAuthenticatedSession(page, account);
          expect(isAuthenticated, `${account.label} could not establish an authenticated browser session in this environment.`).toBeTruthy();

          await page.goto(`${appBaseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
          await expect(page.getByRole('heading', { name: /notification preferences/i })).toBeVisible({ timeout: 15_000 });
          await expect(page.getByText(/invalid guid/i)).toHaveCount(0);
          await expect(page.getByText(/api 500/i)).toHaveCount(0);
          await page.waitForTimeout(1_200);

          const unsupportedMemberDetailIds = nonUuidMemberDetailIds.filter((value) => value.toLowerCase() !== 'me');
          expect(unsupportedMemberDetailIds, 'preferences should only request member detail by UUID or "me"').toHaveLength(0);
          expect(invalidGuidErrors, 'members detail requests should never return Invalid GUID').toHaveLength(0);
        } finally {
          page.off('response', responseListener);
        }
      });

      test('tavf new route respects non-admin access rule', async ({ page }) => {

        const isAuthenticated = await ensureAuthenticatedSession(page, account);
        expect(isAuthenticated, `${account.label} could not establish an authenticated browser session in this environment.`).toBeTruthy();

        const isAdmin = await hasAdminRoleInSession(page);
        await page.goto(`${appBaseUrl}/tavf/new`, { waitUntil: 'domcontentloaded' });

        if (isAdmin) {
          await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
        } else {
          await expect(page).toHaveURL(/\/tavf\/new(\?|$)/, { timeout: 15_000 });
        }
      });
    });
  }
});
