import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');

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
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/admin.json'),
    canAccessAdmin: true,
    canCreateEvents: true,
    tavfNewAllowed: false,
  },
  {
    label: 'event_creator',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/event-creator.json'),
    canAccessAdmin: false,
    canCreateEvents: true,
    tavfNewAllowed: true,
  },
  {
    label: 'member',
    statePath: path.resolve(process.cwd(), 'tests/e2e/.auth/member.json'),
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

test.describe('Browser persona flow matrix', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');
  test.setTimeout(180_000);

  for (const persona of personas) {
    test.describe(persona.label, () => {
      test.use({ storageState: persona.statePath });
      test.skip(!fs.existsSync(persona.statePath), `${persona.label} storage state is missing.`);

      test('base protected routes stay authenticated', async ({ page }) => {
        for (const route of protectedRoutes) {
          await page.goto(`${appBaseUrl}${route}`, { waitUntil: 'domcontentloaded' });
          await expect(page).toHaveURL(new RegExp(`${route}(\\?|$)`), { timeout: 15_000 });
          await expect(page).not.toHaveURL(/\/login(\?|$)/);
        }
      });

      test('admin route access follows role policy', async ({ page }) => {
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
        await page.goto(`${appBaseUrl}${assignmentRoute}`, { waitUntil: 'domcontentloaded' });
        if (persona.canAccessAdmin) {
          await expect(page).toHaveURL(/\/events\/.+\/assign(\?|$)/, { timeout: 15_000 });
        } else {
          await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
        }
      });

      test('tavf new route follows disallowed admin rule', async ({ page }) => {
        await page.goto(`${appBaseUrl}/tavf/new`, { waitUntil: 'domcontentloaded' });
        if (persona.tavfNewAllowed) {
          await expect(page).toHaveURL(/\/tavf\/new(\?|$)/, { timeout: 15_000 });
        } else {
          await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 });
        }
      });

      test('events page action visibility follows persona capability', async ({ page }) => {
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
