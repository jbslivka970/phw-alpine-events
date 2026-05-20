import { expect, test, type Page } from '@playwright/test';
import { authenticateWithVariantA } from './helpers/e2eExchangeAuth';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const variantAEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_AUTH_VARIANT_A_ENABLED ?? '');

type Persona = {
  label: 'admin' | 'event_creator' | 'member';
  statePath: string;
  canAccessAdmin: boolean;
  canCreateEvents: boolean;
  tavfNewAllowed: boolean;
};

const personas: Persona[] = [
  {
    label: 'admin',
    statePath: 'tests/e2e/.auth/admin.json',
    canAccessAdmin: true,
    canCreateEvents: true,
    tavfNewAllowed: true,
  },
  {
    label: 'event_creator',
    statePath: 'tests/e2e/.auth/event-creator.json',
    canAccessAdmin: false,
    canCreateEvents: true,
    tavfNewAllowed: true,
  },
  {
    label: 'member',
    statePath: 'tests/e2e/.auth/member.json',
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

async function completeUsernameStep(authPage: Page, username: string): Promise<boolean> {
  void authPage; void username;
  return false;
}

async function completePasswordStep(authPage: Page, password: string): Promise<boolean> {
  void authPage; void password;
  return false;
}

async function ensureAuthenticatedSession(page: Page, persona: Persona): Promise<boolean> {
  if (await authenticateWithVariantA(page, { appBaseUrl, persona: persona.label })) {
    return true;
  }

  if (await hasAuthenticatedSession(page, appBaseUrl)) {
    return true;
  }

  return false;
}

async function hasAuthenticatedSession(page: Page, appBaseUrlValue: string): Promise<boolean> {
  await page.goto(`${appBaseUrlValue}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return !/\/login(\?|$)/.test(page.url());
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
  test.setTimeout(300_000);

  for (const persona of personas) {
    test.describe(persona.label, () => {
      // Load pre-captured MSAL v5 browser storage state from the refresh job.
      // ensureAuthenticatedSession will detect auth from storageState and skip popup login.
      // Falls back to credential popup login if storageState is empty or tokens are expired.
      test.use({ storageState: persona.statePath });

  test.skip(!localE2EAuthEnabled && !variantAEnabled, `${persona.label}: E2E_LOCAL_AUTH_ENABLED or E2E_AUTH_VARIANT_A_ENABLED is required.`);

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

      test('admin routes follow persona access', async ({ page }) => {
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
        if (persona.canCreateEvents) {
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
