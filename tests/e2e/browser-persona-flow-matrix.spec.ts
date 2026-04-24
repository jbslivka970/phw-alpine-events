import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');

type Persona = {
  label: 'admin' | 'event_creator' | 'member';
  statePath: string;
  username: string;
  password: string;
  canAccessAdmin: boolean;
  canCreateEvents: boolean;
  tavfNewAllowed: boolean;
};

const personas: Persona[] = [
  {
    label: 'admin',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/admin.json'),
    username: process.env.PW_ADMIN_USER ?? '',
    password: process.env.PW_ADMIN_PASS ?? '',
    canAccessAdmin: true,
    canCreateEvents: true,
    tavfNewAllowed: true,
  },
  {
    label: 'event_creator',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/event-creator.json'),
    username: process.env.PW_EVENT_CREATOR_USER ?? '',
    password: process.env.PW_EVENT_CREATOR_PASS ?? '',
    canAccessAdmin: false,
    canCreateEvents: true,
    tavfNewAllowed: true,
  },
  {
    label: 'member',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/member.json'),
    username: process.env.PW_MEMBER_USER ?? '',
    password: process.env.PW_MEMBER_PASS ?? '',
    canAccessAdmin: false,
    canCreateEvents: false,
    tavfNewAllowed: true,
  },
];

const protectedRoutes = [
  '/dashboard',
  '/events',
  '/calendar',
  '/preferences',
  '/tavf',
] as const;

const adminRoutes = [
  '/members',
  '/groups',
  '/import',
  '/reports',
  '/templates',
  '/admin',
] as const;

const assignmentRoute = '/events/00000000-0000-0000-0000-000000000001/assign';
const authStepMaxAttempts = 60;
const authStepSleepMs = 800;

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

  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await authPage.waitForTimeout(2_000);
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
}

async function ensureAuthenticatedSession(page: Page, persona: Persona): Promise<boolean> {
  if (await hasAuthenticatedSession(page, appBaseUrl)) {
    return true;
  }

  if (!persona.username || !persona.password) {
    return false;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await clearBrowserSession(page);
    try {
      await loginWithCredentials(page, persona.username, persona.password);
      if (await hasAuthenticatedSession(page, appBaseUrl)) {
        return true;
      }
    } catch {
      // Continue to one more retry because CIAM UI can be transient in headless CI.
    }
  }

  return false;
}

async function hasAuthenticatedSession(page: Page, appBaseUrlValue: string): Promise<boolean> {
  await page.goto(`${appBaseUrlValue}/dashboard`, { waitUntil: 'domcontentloaded' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (/\/login(\?|$)/.test(page.url())) {
    return false;
  }
  const signInVisible = await page.getByRole('button', { name: /sign in/i }).first().isVisible().catch(() => false);
  return !signInVisible;
}

async function seedLocalAuthRole(page: Page, label: Persona['label']): Promise<void> {
  if (!localE2EAuthEnabled) {
    return;
  }

  const roleValue = label === 'admin' ? 'ADMIN' : label === 'event_creator' ? 'EVENT_CREATOR' : 'USER';
  await page.addInitScript(({ role }) => {
    window.localStorage.setItem('phw_e2e_local_auth', '1');
    window.localStorage.setItem('phw_e2e_role', role);
  }, { role: roleValue });
}

test.describe('Browser persona flow matrix', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.setTimeout(180_000);

  for (const persona of personas) {
    test.describe(persona.label, () => {
      if (!localE2EAuthEnabled) {
        test.use({ storageState: persona.statePath });
        test.skip(!fs.existsSync(persona.statePath), `${persona.label} storage state is missing.`);
      }

      test('base protected routes stay authenticated', async ({ page }) => {
        await seedLocalAuthRole(page, persona.label);
        const isAuthenticated = await ensureAuthenticatedSession(page, persona);
        expect(isAuthenticated, `${persona.label} storage state is present but not authenticated for this environment.`).toBeTruthy();

        for (const route of protectedRoutes) {
          await page.goto(`${appBaseUrl}${route}`, { waitUntil: 'domcontentloaded' });
          await expect(page).toHaveURL(new RegExp(`${route}(\\?|$)`), { timeout: 15_000 });
          await expect(page).not.toHaveURL(/\/login(\?|$)/);
        }
      });

      test('admin route access follows role policy', async ({ page }) => {
        await seedLocalAuthRole(page, persona.label);
        const isAuthenticated = await ensureAuthenticatedSession(page, persona);
        expect(isAuthenticated, `${persona.label} storage state is present but not authenticated for this environment.`).toBeTruthy();

        for (const route of adminRoutes) {
          await page.goto(`${appBaseUrl}${route}`, { waitUntil: 'domcontentloaded' });

          if (persona.canAccessAdmin) {
            await expect(page).toHaveURL(new RegExp(`${route}(\\?|$)`), { timeout: 15_000 });
          } else {
            await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
          }
        }
      });

      test('event assignment route respects admin gate', async ({ page }) => {
        await seedLocalAuthRole(page, persona.label);
        const isAuthenticated = await ensureAuthenticatedSession(page, persona);
        expect(isAuthenticated, `${persona.label} storage state is present but not authenticated for this environment.`).toBeTruthy();

        await page.goto(`${appBaseUrl}${assignmentRoute}`, { waitUntil: 'domcontentloaded' });
        if (persona.canAccessAdmin) {
          await expect(page).toHaveURL(/\/events\/.+\/assign(\?|$)/, { timeout: 15_000 });
        } else {
          await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
        }
      });

      test('tavf new route follows disallowed admin rule', async ({ page }) => {
        await seedLocalAuthRole(page, persona.label);
        const isAuthenticated = await ensureAuthenticatedSession(page, persona);
        expect(isAuthenticated, `${persona.label} storage state is present but not authenticated for this environment.`).toBeTruthy();

        await page.goto(`${appBaseUrl}/tavf/new`, { waitUntil: 'domcontentloaded' });
        if (persona.tavfNewAllowed) {
          await expect(page).toHaveURL(/\/tavf\/new(\?|$)/, { timeout: 15_000 });
        } else {
          await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
        }
      });

      test('events page action visibility follows persona capability', async ({ page }) => {
        await seedLocalAuthRole(page, persona.label);
        const isAuthenticated = await ensureAuthenticatedSession(page, persona);
        expect(isAuthenticated, `${persona.label} storage state is present but not authenticated for this environment.`).toBeTruthy();

        await page.goto(`${appBaseUrl}/events`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible({ timeout: 15_000 });

        const newEventButton = page.getByRole('button', { name: /\+ New Event/i });
        if (persona.canCreateEvents) {
          await expect(newEventButton).toBeVisible();
        } else {
          await expect(newEventButton).toHaveCount(0);
        }
      });
    });
  }
});
