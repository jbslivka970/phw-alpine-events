import { expect, test, type Page } from '@playwright/test';
import { authenticateWithVariantA } from './helpers/e2eExchangeAuth';

declare const process: { env: Record<string, string | undefined> };

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const variantAEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_AUTH_VARIANT_A_ENABLED ?? '');

type BrowserAccount = {
  label: string;
  statePath: string;
};

const accounts: BrowserAccount[] = [
  {
    label: 'event_creator',
    statePath: 'tests/e2e/.auth/event-creator.json',
  },
  {
    label: 'member',
    statePath: 'tests/e2e/.auth/member.json',
  },
];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  void page;
}

async function ensureAuthenticatedSession(page: Page, account: BrowserAccount): Promise<boolean> {
  if (localE2EAuthEnabled) {
    await seedLocalAuthRole(page, account.label);
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    return appearsAuthenticated(page);
  }

  if (await authenticateWithVariantA(page, { appBaseUrl, persona: account.label })) {
    return true;
  }

  await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await appearsAuthenticated(page)) {
    return true;
  }

  return false;
}

test.describe('Browser role flows (credential login)', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.setTimeout(300_000);

  for (const account of accounts) {
    test.describe(account.label, () => {
      // Load pre-captured MSAL v5 browser storage state from the refresh job.
      // ensureAuthenticatedSession will detect auth from storageState and skip popup login.
      // Falls back to credential popup login if storageState is empty or tokens are expired.
      test.use({ storageState: account.statePath });

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
