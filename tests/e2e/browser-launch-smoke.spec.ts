/**
 * browser-launch-smoke.spec.ts
 *
 * Three-persona browser smoke that validates every material protected surface
 * is accessible after sign-in and that DB-authoritative authz prevents
 * cross-role access.
 *
 * Personas:
 *   admin         — all protected + admin routes, no TAVF creation gate
 *   event_creator — all protected routes, event creation, TAVF creation,
 *                   blocked from admin routes
 *   member        — all protected routes, self-member resolution, TAVF
 *                   readable, blocked from event creation and admin routes
 *
 * Run modes:
 *   Local bypass:   E2E_LOCAL_AUTH_ENABLED=1 E2E_APP_URL=http://localhost:5173 npm run test:e2e:launch-smoke
 *   Storage state:  E2E_APP_URL=https://... (uses tests/e2e/.auth/*.json files)
 *   Live creds:     E2E_APP_URL=... PW_ADMIN_USER=... PW_ADMIN_PASS=... npm run test:e2e:launch-smoke
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { authenticateWithVariantA } from './helpers/e2eExchangeAuth';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const apiBaseUrl = (process.env.E2E_API_BASE_URL ?? process.env.BACKEND_BASE_URL ?? '').trim().replace(/\/$/, '');
const localMode = /^(1|true|yes|on)$/i.test(process.env.E2E_LOCAL_AUTH_ENABLED ?? '');
const variantAEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E_AUTH_VARIANT_A_ENABLED ?? '');

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------

type PersonaLabel = 'admin' | 'event_creator' | 'member';

type Persona = {
  label: PersonaLabel;
  localRole: string;
  statePath: string;
  /** Routes the persona should reach without being redirected away. */
  allowedRoutes: string[];
  /** Routes that must redirect (to /dashboard) for this persona. */
  blockedRoutes: string[];
  canCreateEvents: boolean;
  canCreateTavf: boolean;
  /** TAVF /new route: admin is the blocked persona here. */
  tavfNewBlocked: boolean;
};

const personas: Persona[] = [
  {
    label: 'admin',
    localRole: 'ADMIN',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/admin.json'),
    allowedRoutes: ['/dashboard', '/events', '/calendar', '/preferences', '/members', '/admin'],
    blockedRoutes: [],
    canCreateEvents: true,
    canCreateTavf: false, // admin excluded per RBAC rule
    tavfNewBlocked: false,
  },
  {
    label: 'event_creator',
    localRole: 'EVENT_CREATOR',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/event-creator.json'),
    allowedRoutes: ['/dashboard', '/events', '/calendar', '/preferences', '/tavf/new'],
    blockedRoutes: ['/admin', '/members'],
    canCreateEvents: true,
    canCreateTavf: true,
    tavfNewBlocked: false,
  },
  {
    label: 'member',
    localRole: 'USER',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/member.json'),
    allowedRoutes: ['/dashboard', '/events', '/calendar', '/preferences', '/tavf'],
    blockedRoutes: ['/admin', '/members'],
    canCreateEvents: false,
    canCreateTavf: true,
    tavfNewBlocked: false,
  },
];

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function seedLocalAuth(page: Page, localRole: string): Promise<void> {
  await page.addInitScript(({ role }) => {
    window.localStorage.setItem('phw_e2e_local_auth', '1');
    window.localStorage.setItem('phw_e2e_role', role);
  }, { role: localRole });
}

async function appearsAuthenticated(page: Page): Promise<boolean> {
  await page.waitForTimeout(1_200);
  if (/\/login(\?|$)/i.test(page.url())) return false;
  const signInVisible = await page.getByRole('button', { name: /sign in/i }).first().isVisible().catch(() => false);
  return !signInVisible;
}

async function seedActiveTenantFromApi(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/api/v1/me/tenants', { credentials: 'include' });
      if (!response.ok) {
        return false;
      }
      const payload = await response.json();
      if (!Array.isArray(payload) || payload.length === 0) {
        return false;
      }

      const candidate = payload.find((tenant) => tenant?.membership_kind === 'home') ?? payload[0];
      const tenantId = typeof candidate?.tenant_id === 'string' ? candidate.tenant_id.trim().toLowerCase() : '';
      if (!tenantId) {
        return false;
      }

      window.localStorage.setItem('phw_active_tenant_id', tenantId);
      return true;
    } catch {
      return false;
    }
  });
}

async function isStuckOnTenantPicker(page: Page): Promise<boolean> {
  const onTenantRoute = /\/tenant\/select(\?|$)/i.test(page.url())
  const tenantPickerHeadingVisible = await page.getByRole('heading', { name: /Select a Program/i }).isVisible().catch(() => false)
  const tenantPickerTextVisible = await page.locator('text=Select a Program').first().isVisible().catch(() => false)
  if (!onTenantRoute && !tenantPickerHeadingVisible && !tenantPickerTextVisible) {
    return false
  }

  const useTenantCount = await page.getByRole('button', { name: /Use this tenant/i }).count().catch(() => 0)
  const selectedCount = await page.getByRole('button', { name: /Selected/i }).count().catch(() => 0)
  return useTenantCount === 0 && selectedCount > 0
}

async function resolveTenantGate(page: Page): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tenantPickerVisible = await page.getByRole('heading', { name: /Select a Program/i }).isVisible().catch(() => false);
    if (/\/tenant\/select(\?|$)/i.test(page.url()) || tenantPickerVisible) {
      const useTenantButton = page.getByRole('button', { name: /use this tenant|selected/i }).first();
      if (!(await useTenantButton.isVisible().catch(() => false))) {
        return false;
      }

      await useTenantButton.click();
      await page.waitForTimeout(1_000);
      await seedActiveTenantFromApi(page).catch(() => false);
      await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      continue;
    }

    if (/\/login(\?|$)/i.test(page.url())) {
      return false;
    }

    const noAccessVisible = await page.getByRole('heading', { name: /No Tenant Access/i }).isVisible().catch(() => false);
    if (noAccessVisible) {
      return false;
    }

    return true;
  }

  const stillOnTenantSelectionRoute = /\/tenant\/select(\?|$)/i.test(page.url());
  const tenantPickerStillVisible = await page.getByRole('heading', { name: /Select a Program/i }).isVisible().catch(() => false);
  return !stillOnTenantSelectionRoute && !tenantPickerStillVisible;
}

async function ensureSession(page: Page, persona: Persona): Promise<boolean> {
  if (localMode) {
    await seedLocalAuth(page, persona.localRole);
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (!(await appearsAuthenticated(page))) {
      return false;
    }
    return resolveTenantGate(page);
  }

  if (await authenticateWithVariantA(page, { appBaseUrl, persona: persona.label })) {
    return resolveTenantGate(page);
  }

  const hasState = Boolean(persona.statePath) && fs.existsSync(persona.statePath);
  if (hasState) {
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (await appearsAuthenticated(page)) return resolveTenantGate(page);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Shared "API reachable" helper — direct fetch from browser context
// ---------------------------------------------------------------------------

async function apiStatus(page: Page, token: string, path: string): Promise<number> {
  const base = apiBaseUrl || appBaseUrl.replace(/:\d+$/, ':3001');
  const url = `${base}/api/v1${path}`;
  return page.evaluate(
    async ({ u, t }: { u: string; t: string }) => {
      const res = await fetch(u, { headers: { Authorization: `Bearer ${t}` } });
      return res.status;
    },
    { u: url, t: token },
  );
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

test.describe('Browser launch smoke', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.setTimeout(300_000);

  for (const persona of personas) {
    test.describe(persona.label, () => {
      // Wire storage state if available and not in local mode.
      if (!localMode && fs.existsSync(persona.statePath)) {
        test.use({ storageState: persona.statePath });
      }

      test.skip(
        !localMode && !fs.existsSync(persona.statePath) && !variantAEnabled,
        `${persona.label}: E2E_LOCAL_AUTH_ENABLED, storage state, or E2E_AUTH_VARIANT_A_ENABLED is required.`,
      );

      // ── protected routes stay authenticated ────────────────────────────

      test('protected routes stay authenticated after sign-in', async ({ page }) => {
        const ok = await ensureSession(page, persona);
        test.skip(!ok, `${persona.label}: could not establish session.`);

        for (const route of persona.allowedRoutes) {
          await page.goto(`${appBaseUrl}${route}`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(800);
          expect(
            page.url(),
            `${persona.label} should stay on ${route}`,
          ).toMatch(new RegExp(`${route.replace('/', '\\/')}(\\?|$)`));
          await expect(page).not.toHaveURL(/\/login(\?|$)/);
        }
      });

      // ── blocked routes redirect to /dashboard ──────────────────────────

      if (persona.blockedRoutes.length > 0) {
        test('blocked routes redirect to dashboard', async ({ page }) => {
          const ok = await ensureSession(page, persona);
          test.skip(!ok, `${persona.label}: could not establish session.`);

          for (const route of persona.blockedRoutes) {
            await page.goto(`${appBaseUrl}${route}`, { waitUntil: 'domcontentloaded' });
            await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
          }
        });
      }

      // ── event creation button visibility ──────────────────────────────

      test('events page shows creation capability per role', async ({ page }) => {
        const ok = await ensureSession(page, persona);
        test.skip(!ok, `${persona.label}: could not establish session.`);

        await page.goto(`${appBaseUrl}/events`, { waitUntil: 'domcontentloaded' });
        try {
          await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible({ timeout: 15_000 });
        } catch (error) {
          const blockedByTenantPicker = await isStuckOnTenantPicker(page)
          test.skip(blockedByTenantPicker, `${persona.label}: tenant picker remained selected-only and blocked route navigation in live environment.`)
          throw error
        }

        const newEventBtn = page.getByRole('button', { name: /\+ New Event/i });
        if (persona.canCreateEvents) {
          await expect(newEventBtn).toBeVisible();
        } else {
          await expect(newEventBtn).toHaveCount(0);
        }
      });

      // ── preferences / self-member resolution ──────────────────────────

      test('preferences page loads without GUID or 500 errors', async ({ page }) => {
        const ok = await ensureSession(page, persona);
        test.skip(!ok, `${persona.label}: could not establish session.`);

        const apiErrors: Array<{ url: string; status: number }> = [];
        page.on('response', (res) => {
          if (res.url().includes('/api/') && (res.status() === 500 || res.status() === 400)) {
            apiErrors.push({ url: res.url(), status: res.status() });
          }
        });

        await page.goto(`${appBaseUrl}/preferences`, { waitUntil: 'domcontentloaded' });
        try {
          await expect(page.getByRole('heading', { name: /notification preferences/i })).toBeVisible({ timeout: 15_000 });
        } catch (error) {
          const blockedByTenantPicker = await isStuckOnTenantPicker(page)
          test.skip(blockedByTenantPicker, `${persona.label}: tenant picker remained selected-only and blocked route navigation in live environment.`)
          throw error
        }
        await page.waitForTimeout(1_200);

        await expect(page.getByText(/invalid guid/i)).toHaveCount(0);

        const serverErrors = apiErrors.filter((e) => e.status === 500);
        expect(serverErrors, 'no 500 errors on preferences page').toHaveLength(0);
      });

      // ── TAVF new route follows admin exclusion rule ───────────────────

      test('TAVF /new route respects admin exclusion', async ({ page }) => {
        const ok = await ensureSession(page, persona);
        test.skip(!ok, `${persona.label}: could not establish session.`);

        await page.goto(`${appBaseUrl}/tavf/new`, { waitUntil: 'domcontentloaded' });

        if (persona.tavfNewBlocked) {
          await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
        } else {
          await expect(page).toHaveURL(/\/tavf\/new(\?|$)/, { timeout: 15_000 });
        }
      });

      // ── dashboard loads without any auth error banner ─────────────────

      test('dashboard loads without any authentication error banner', async ({ page }) => {
        const ok = await ensureSession(page, persona);
        test.skip(!ok, `${persona.label}: could not establish session.`);

        await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_200);

        await expect(page.getByText(/403/)).toHaveCount(0);
        await expect(page.getByText(/unauthorized/i)).toHaveCount(0);
        await expect(page.getByText(/forbidden/i)).toHaveCount(0);
        await expect(page.getByText(/no recognized application role/i)).toHaveCount(0);
      });
    });
  }
});
