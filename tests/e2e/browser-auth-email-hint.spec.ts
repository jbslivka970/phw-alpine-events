import path from 'node:path';
import { expect, test, type Request } from '@playwright/test';

const appBaseUrl = (process.env.E2E_APP_URL ?? '').trim().replace(/\/$/, '');
const memberStatePath = path.resolve(process.cwd(), 'tests/e2e/.auth/member.json');

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payloadPart = parts[1]?.replace(/-/g, '+').replace(/_/g, '/');
    if (!payloadPart) {
      return null;
    }
    const padded = payloadPart + '='.repeat((4 - (payloadPart.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

test.describe('Auth Email Hint Regression', () => {
  test.skip(!appBaseUrl, 'E2E_APP_URL is required.');

  test.use({ storageState: memberStatePath });

  test('uses id token email for backend email hint header', async ({ page }) => {
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
      const url = request.url().toLowerCase();
      if (!url.includes('/api/v1/')) {
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

    // Force one additional request path so we do not rely on a single page load pattern.
    await page.goto(`${appBaseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);

    page.off('request', onRequest);

    expect(capturedHeader, 'frontend should send X-Id-Token-Email on API calls').toBeTruthy();
    expect(capturedHeader).toBe(idTokenEmail);

    // Sanity check token structure if a bearer header was observed.
    const accessToken = await page.evaluate(() => {
      const keys = Object.keys(window.localStorage);
      const accessTokenKey = keys.find((key) => key.toLowerCase().includes('accesstoken'));
      if (!accessTokenKey) {
        return null;
      }

      try {
        const raw = window.localStorage.getItem(accessTokenKey);
        if (!raw) {
          return null;
        }
        const parsed = JSON.parse(raw) as { secret?: string };
        return parsed.secret ?? null;
      } catch {
        return null;
      }
    });

    const accessClaims = decodeJwtPayload(accessToken ?? undefined);
    expect(accessClaims && typeof accessClaims === 'object').toBeTruthy();
  });
});
