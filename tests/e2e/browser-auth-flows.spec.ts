import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');

type BrowserAccount = {
  label: string;
  username: string;
  password: string;
};

const accounts: BrowserAccount[] = [
  {
    label: 'event_creator',
    username: process.env.PW_EVENT_CREATOR_USER ?? '',
    password: process.env.PW_EVENT_CREATOR_PASS ?? '',
  },
  {
    label: 'member',
    username: process.env.PW_MEMBER_USER ?? '',
    password: process.env.PW_MEMBER_PASS ?? '',
  },
];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authStateByLabel: Record<string, string> = {
  event_creator: path.resolve(process.cwd(), 'tests/e2e/.auth/event-creator.json'),
  member: path.resolve(process.cwd(), 'tests/e2e/.auth/member.json'),
};

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
  for (let i = 0; i < 45; i += 1) {
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

    await authPage.waitForTimeout(800);
  }

  return false;
}

async function completePasswordStep(authPage: Page, password: string): Promise<boolean> {
  for (let i = 0; i < 45; i += 1) {
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

    await authPage.waitForTimeout(800);
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
  const passFilled = await completePasswordStep(authPage, password);
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

  await expect(page).toHaveURL(/\/dashboard|\/events|\/tavf|\/$/, { timeout: 90_000 });
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

async function ensureAuthenticatedSession(page: Page, account: BrowserAccount): Promise<void> {
  const statePath = authStateByLabel[account.label] ?? '';
  const hasStateFile = Boolean(statePath) && fs.existsSync(statePath);

  if (hasStateFile) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (!/\/login(\?|$)/.test(page.url())) {
      return;
    }
  }

  await loginWithCredentials(page, account.username, account.password);
}

test.describe('Browser role flows (credential login)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.setTimeout(300_000);

  for (const account of accounts) {
    const storageStatePath = authStateByLabel[account.label] ?? '';
    const hasStorageState = Boolean(storageStatePath) && fs.existsSync(storageStatePath);

    test.describe(account.label, () => {
      if (hasStorageState) {
        test.use({ storageState: storageStatePath });
      }

      test.skip(!hasStorageState && (!account.username || !account.password), `${account.label} credentials are required when storage state is missing.`);

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
          await ensureAuthenticatedSession(page, account);

          await page.goto(`${appBaseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
          await expect(page.getByRole('heading', { name: /notification preferences/i })).toBeVisible({ timeout: 15_000 });
          await expect(page.getByText(/invalid guid/i)).toHaveCount(0);
          await expect(page.getByText(/api 500/i)).toHaveCount(0);
          await page.waitForTimeout(1_200);

          expect(nonUuidMemberDetailIds, 'preferences should only request member detail by UUID').toHaveLength(0);
          expect(invalidGuidErrors, 'members detail requests should never return Invalid GUID').toHaveLength(0);
        } finally {
          page.off('response', responseListener);
        }
      });

      test('tavf new route respects non-admin access rule', async ({ page }) => {

        await ensureAuthenticatedSession(page, account);

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
