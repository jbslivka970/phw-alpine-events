#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Use CJS require.resolve() to check package existence — this is always
// synchronous and catchable, avoiding the ESM _link-phase crash that
// occurs in Node.js 22+ when import() targets a non-existent package.
const _require = createRequire(import.meta.url);
function packageInstalled(name) {
  try { _require.resolve(name); return true; } catch { return false; }
}

let chromiumLoader = null;

async function getChromium() {
  if (!chromiumLoader) {
    chromiumLoader = (async () => {
      // Prefer @playwright/test (always present after `npm ci`), then playwright.
      if (packageInstalled('@playwright/test')) {
        const m = await import('@playwright/test');
        return m.chromium;
      }
      if (packageInstalled('playwright')) {
        const m = await import('playwright');
        return m.chromium;
      }
      throw new Error(
        'Playwright browser runtime is unavailable. Install either "@playwright/test" or "playwright" before running browser token refresh.'
      );
    })();
  }

  return chromiumLoader;
}

const args = new Set(process.argv.slice(2));
const softSkip = args.has('--soft-skip');
const tokenEnvFile = (process.env.PW_TOKEN_ENV_FILE || '').trim();
const perRoleTimeoutMs = Number.parseInt(process.env.PW_REFRESH_ROLE_TIMEOUT_MS || '180000', 10);
const maxRefreshAttempts = Number.parseInt(
  process.env.PW_REFRESH_MAX_ATTEMPTS || (process.env.CI ? '2' : '2'),
  10,
);
const postLoginTimeoutMs = Number.isFinite(perRoleTimeoutMs) && perRoleTimeoutMs > 0
  ? Math.max(90_000, perRoleTimeoutMs - 10_000)
  : 90_000;

/* ── ROPC (Resource Owner Password Credentials) configuration ─────────── */
const ropcPolicy = (process.env.AZURE_B2C_ROPC_POLICY || '').trim();
const azureTenantName = (
  process.env.AZURE_EXTERNAL_TENANT_NAME ||
  process.env.AZURE_AD_B2C_TENANT_NAME ||
  ''
).trim();
const azureTenantId = (
  process.env.AZURE_EXTERNAL_TENANT_ID ||
  process.env.AZURE_TENANT_ID ||
  ''
).trim();
const azureClientId = (process.env.AZURE_CLIENT_ID || '').trim();
const azureClientSecret = (process.env.AZURE_CLIENT_SECRET || '').trim();
const configuredApiScope = (
  process.env.AZURE_API_SCOPE ||
  process.env.VITE_API_SCOPE ||
  process.env.E2E_API_SCOPE ||
  ''
).trim();
const azureAuthorityHost = (process.env.AZURE_AUTHORITY_HOST || 'b2clogin.com').trim();
const isCiamAuthority = azureAuthorityHost.includes('ciamlogin');
const ropcEnabled = Boolean(
  azureTenantName
  && azureClientId
  && (isCiamAuthority ? azureTenantId : ropcPolicy)
);

const appUrl = (process.env.E2E_APP_URL || '').trim().replace(/\/$/, '');
const authDir = path.resolve(process.cwd(), 'tests/e2e/.auth');
const appOrigin = (() => {
  try {
    return new URL(appUrl).origin;
  } catch {
    return appUrl;
  }
})();

const roles = [
  {
    name: 'event_creator',
    username: process.env.PW_EVENT_CREATOR_USER,
    password: process.env.PW_EVENT_CREATOR_PASS,
    tokenEnv: 'PW_EVENT_CREATOR_TOKEN',
    statePath: path.join(authDir, 'event-creator.json'),
  },
  {
    name: 'member',
    username: process.env.PW_MEMBER_USER,
    password: process.env.PW_MEMBER_PASS,
    tokenEnv: 'PW_MEMBER_TOKEN',
    statePath: path.join(authDir, 'member.json'),
  },
  {
    name: 'admin',
    username: process.env.PW_ADMIN_USER,
    password: process.env.PW_ADMIN_PASS,
    tokenEnv: 'PW_ADMIN_TOKEN',
    statePath: path.join(authDir, 'admin.json'),
  },
];

/* ── ROPC token acquisition (no browser, single HTTP POST) ────────────── */

function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return {};
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function acquireTokenByROPC(role) {
  if (!ropcEnabled) return null;

  const isCiam = azureAuthorityHost.includes('ciamlogin');
  const requestedScope = configuredApiScope || azureClientId;
  const tokenUrl = isCiam
    ? `https://${azureTenantName}.${azureAuthorityHost}/${azureTenantId}/oauth2/v2.0/token`
    : `https://${azureTenantName}.${azureAuthorityHost}/${azureTenantName}.onmicrosoft.com/${ropcPolicy}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: azureClientId,
    scope: `openid profile email ${requestedScope} offline_access`,
    username: role.username,
    password: role.password,
  });
  if (azureClientSecret) {
    body.set('client_secret', azureClientSecret);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (!azureClientSecret && /AADSTS7000218|invalid_client/i.test(text)) {
        throw new Error(`ROPC ${resp.status}: ${text.slice(0, 500)} (hint: AZURE_CLIENT_SECRET is required for confidential clients)`);
      }
      throw new Error(`ROPC ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return {
      accessToken: data.access_token,
      idToken: data.id_token ?? null,
      expiresIn: data.expires_in ?? 3600,
      scope: data.scope ?? '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Build a Playwright storageState JSON with MSAL-compatible cache entries
 * so that browser tests can start in an authenticated state without
 * performing an interactive login.
 */
function buildSyntheticStorageState(ropcResult, appOrigin) {
  const idClaims = ropcResult.idToken ? decodeJwtPayload(ropcResult.idToken) : {};
  const accessClaims = decodeJwtPayload(ropcResult.accessToken);

  const oid = idClaims.oid || accessClaims.oid || accessClaims.sub || 'unknown';
  const tid = idClaims.tid || accessClaims.tid || azureTenantId || '';
  const issuer = idClaims.iss || accessClaims.iss || '';
  const environment = issuer ? (() => { try { return new URL(issuer).hostname; } catch { return azureAuthorityHost; } })() : azureAuthorityHost;
  const username = idClaims.preferred_username || idClaims.email || idClaims.emails?.[0] || '';
  const name = idClaims.name || '';

  const homeAccountId = `${oid}.${tid}`;
  const realm = tid;
  const clientInfo = Buffer.from(JSON.stringify({ uid: oid, utid: tid })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresOn = now + (ropcResult.expiresIn || 3600);
  const target = ropcResult.scope || `openid profile email ${azureClientId}`;

  const accountKey = `${homeAccountId}-${environment}-${realm}`;
  const accessTokenKey = `${homeAccountId}-${environment}-accesstoken-${azureClientId}-${realm}-${target}`;
  const idTokenKey = `${homeAccountId}-${environment}-idtoken-${azureClientId}-${realm}`;

  const entries = [
    {
      name: accountKey,
      value: JSON.stringify({
        homeAccountId,
        environment,
        realm,
        localAccountId: oid,
        username,
        name,
        authorityType: 'MSSTS',
        clientInfo,
      }),
    },
    {
      name: accessTokenKey,
      value: JSON.stringify({
        homeAccountId,
        environment,
        credentialType: 'AccessToken',
        clientId: azureClientId,
        secret: ropcResult.accessToken,
        realm,
        target,
        cachedAt: String(now),
        expiresOn: String(expiresOn),
        extendedExpiresOn: String(expiresOn + 3600),
        tokenType: 'Bearer',
      }),
    },
  ];

  if (ropcResult.idToken) {
    entries.push({
      name: idTokenKey,
      value: JSON.stringify({
        homeAccountId,
        environment,
        credentialType: 'IdToken',
        clientId: azureClientId,
        secret: ropcResult.idToken,
        realm,
      }),
    });
  }

  // Active account marker so MSAL knows which account to use
  entries.push({
    name: `msal.${azureClientId}.active-account`,
    value: accountKey,
  });

  return {
    cookies: [],
    origins: [{ origin: appOrigin, localStorage: entries }],
  };
}

/* ── Browser-based login helpers (fallback when ROPC unavailable) ─────── */

async function loginAndCaptureWithTimeout(role) {
  if (!Number.isFinite(perRoleTimeoutMs) || perRoleTimeoutMs <= 0) {
    return loginAndCaptureWithRetries(role);
  }

  const abortState = { aborted: false };
  return Promise.race([
    loginAndCaptureWithRetries(role, abortState),
    new Promise((_, reject) => {
      setTimeout(() => {
        abortState.aborted = true;
        reject(new Error(`Timed out after ${perRoleTimeoutMs}ms while refreshing ${role.name}.`));
      }, perRoleTimeoutMs);
    }),
  ]);
}

async function loginAndCaptureWithRetries(role, abortState = { aborted: false }) {
  let lastError = null;
  const attemptLimit = Number.isFinite(maxRefreshAttempts) && maxRefreshAttempts > 0
    ? maxRefreshAttempts
    : 1;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    if (abortState.aborted) break;
    try {
      return await loginAndCapture(role);
    } catch (error) {
      if (abortState.aborted) break;
      lastError = error;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[refresh-playwright-tokens] attempt ${attempt} failed for ${role.name}: ${reason}`);
    }
  }

  if (!abortState.aborted) {
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(`Failed to refresh ${role.name} token after retries.`);
  }
}

function failOrSkip(message) {
  if (softSkip) {
    console.warn(`[refresh-playwright-tokens] skipped: ${message}`);
    process.exit(0);
  }
  throw new Error(message);
}

function getScopes(page) {
  return [page, ...page.frames()];
}

async function fillIfVisible(scope, selectors, value) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function clickIfVisible(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function fillInAnyScope(page, selectors, value) {
  for (const scope of getScopes(page)) {
    if (await fillIfVisible(scope, selectors, value)) {
      return true;
    }
  }
  return false;
}

async function clickInAnyScope(page, selectors) {
  for (const scope of getScopes(page)) {
    if (await clickIfVisible(scope, selectors)) {
      return true;
    }
  }
  return false;
}

async function waitForPostLoginReady(page, timeoutMs) {
  const loginUrlPattern = /\/dashboard|\/events|\/tavf|\/$/;

  await Promise.race([
    page.waitForURL(loginUrlPattern, { timeout: timeoutMs, waitUntil: 'domcontentloaded' }),
    page.waitForFunction(() => {
      const pathname = window.location.pathname || '/';
      if (/\/dashboard|\/events|\/tavf|\/$/.test(pathname)) {
        return true;
      }

      const sources = [window.sessionStorage, window.localStorage];
      for (const source of sources) {
        for (const key of Object.keys(source)) {
          const raw = source.getItem(key);
          if (!raw) {
            continue;
          }

          if (raw.startsWith('eyJ') && raw.length > 20) {
            return true;
          }

          try {
            const parsed = JSON.parse(raw);
            const possible = [
              parsed.secret,
              parsed.accessToken,
              parsed.access_token,
              parsed.idToken,
              parsed.id_token,
              parsed.token,
            ];
            if (possible.some((candidate) => typeof candidate === 'string' && candidate.length > 20)) {
              return true;
            }
          } catch {
            // Ignore malformed cache entries.
          }
        }
      }
      return false;
    }, undefined, { timeout: timeoutMs }),
  ]);
}

async function completeUsernameStep(authPage, username) {
  for (let i = 0; i < 45; i += 1) {
    await clickInAnyScope(authPage, [
      `text=${username}`,
      `[data-test-id="${username}"]`,
      `[data-test-id="displayName"]`,
      'div[role="button"]:has-text("Use another account")',
      'div[role="button"]:has-text("Sign in")',
    ]);

    const entered = await fillInAnyScope(
      authPage,
      [
        'input[type="email"]',
        'input[type="text"]',
        'input[name="loginfmt"]',
        'input[name="identifier"]',
        'input#i0116',
        'input[name="signInName"]',
        'input#username',
        'input[placeholder*="Email"]',
        'input[placeholder*="email"]',
        'input[placeholder*="phone"]',
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

async function completePasswordStep(authPage, password) {
  for (let i = 0; i < 45; i += 1) {
    await clickInAnyScope(authPage, [
      'a:has-text("Use password")',
      'button:has-text("Use password")',
      'a:has-text("Sign in with a password")',
      'button:has-text("Sign in with a password")',
      'a:has-text("Sign-in options")',
      'button:has-text("Sign-in options")',
      'a:has-text("Other ways to sign in")',
      'button:has-text("Other ways to sign in")',
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

    await authPage.waitForTimeout(800);
  }

  return false;
}

async function loginAndCapture({ username, password, name, statePath }) {
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let headerToken = null;

  context.on('request', (request) => {
    const authHeader = request.headers()['authorization'] || request.headers()['Authorization'];
    if (!authHeader || headerToken) {
      return;
    }
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      headerToken = match[1].trim();
    }
  });

  try {
    await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' });
    let popup = null;
    let authPage = page;

    const onIdentityProvider = () => /login\.microsoftonline\.com|b2clogin\.com|ciamlogin\.com/i.test(page.url());
    const signInButton = page.getByRole('button', { name: /sign in/i });

    if (!onIdentityProvider()) {
      await signInButton.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => null);
      if (await signInButton.isVisible().catch(() => false)) {
        const popupPromise = page.waitForEvent('popup', { timeout: 12_000 }).catch(() => null);
        await signInButton.click();
        popup = await popupPromise;
        authPage = popup || page;
      } else {
        // Some environments auto-start the auth flow without rendering the local sign-in button.
        await clickInAnyScope(page, [
          'button:has-text("Sign in")',
          'button:has-text("Continue")',
          'a:has-text("Sign in")',
          'a:has-text("Continue")',
        ]);
        await page.waitForTimeout(1500);
        if (onIdentityProvider()) {
          authPage = page;
        }
      }
    }

    await authPage.waitForLoadState('domcontentloaded').catch(() => {});
    const userFilled = await completeUsernameStep(authPage, username);
    if (!userFilled) {
      throw new Error('Could not find username input in auth flow.');
    }

    await authPage.waitForLoadState('domcontentloaded').catch(() => {});
    await authPage.waitForTimeout(2_000);
    const passFilled = await completePasswordStep(authPage, password);
    if (!passFilled) {
      throw new Error('Could not find password input in auth flow.');
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
      await page.goto(`${appUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const onLogin = /\/login(\?|$)/i.test(page.url());
      if (!onLogin) {
        break;
      }
      await page.waitForTimeout(2_500);
    }

    await waitForPostLoginReady(page, postLoginTimeoutMs);
    await page.waitForTimeout(1_200);

    const storageToken = await page.evaluate(() => {
      const sources = [window.sessionStorage, window.localStorage];
      for (const source of sources) {
        for (const key of Object.keys(source)) {
          try {
            const parsed = JSON.parse(source.getItem(key) ?? '{}');
            const possible = [parsed.secret, parsed.accessToken, parsed.access_token, parsed.idToken, parsed.id_token];
            for (const candidate of possible) {
              if (typeof candidate === 'string' && candidate.length > 20) {
                return candidate;
              }
            }

            if (typeof parsed.token === 'string' && parsed.token.length > 20) {
              return parsed.token;
            }
          } catch {
            // Ignore malformed cache entries.
          }

          const raw = source.getItem(key);
          if (typeof raw === 'string' && raw.startsWith('eyJ') && raw.length > 20) {
            return raw;
          }
        }
      }
      return null;
    });

    const token = headerToken ?? storageToken;

    if (!token) {
      throw new Error('Could not extract access token from MSAL cache.');
    }

    await context.storageState({ path: statePath });
    return token;
  } catch (loginError) {
    // Capture debug screenshot on failure for CI artifact upload
    const screenshotPath = path.join(authDir, `${name || 'unknown'}-failure.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.warn(`[refresh-playwright-tokens] saved failure screenshot: ${screenshotPath}`);
    } catch {
      // Ignore screenshot capture failure
    }
    throw loginError;
  } finally {
    await context.close();
    await browser.close();
  }
}

function exportToken(name, value) {
  console.log(`::add-mask::${value}`);
  process.env[name] = value;

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`, 'utf8');
  }

  if (tokenEnvFile) {
    const escapedValue = value.replace(/'/g, "'\\''");
    fs.appendFileSync(tokenEnvFile, `export ${name}='${escapedValue}'\n`, 'utf8');
  }
}

async function main() {
  if (!appUrl) {
    failOrSkip('E2E_APP_URL is required.');
    return;
  }

  fs.mkdirSync(authDir, { recursive: true });
  if (tokenEnvFile) {
    fs.writeFileSync(tokenEnvFile, '', 'utf8');
  }

  const configuredRoles = roles.filter((role) => role.username && role.password);
  if (configuredRoles.length === 0) {
    failOrSkip('No role credentials provided (PW_*_USER / PW_*_PASS).');
    return;
  }

  if (ropcEnabled) {
    const effectiveScope = configuredApiScope || azureClientId;
    const secretMode = azureClientSecret ? 'set' : 'not-set';
    console.log(`[refresh-playwright-tokens] ROPC is configured — will try direct token acquisition first (scope=${effectiveScope}, client_secret=${secretMode}).`);
  } else {
    console.log('[refresh-playwright-tokens] ROPC not configured — using browser login. Set AZURE_B2C_ROPC_POLICY, AZURE_CLIENT_ID, and AZURE_*_TENANT_NAME to enable ROPC.');
  }

  let refreshedCount = 0;
  for (const role of configuredRoles) {
    console.log(`[refresh-playwright-tokens] refreshing ${role.name}...`);

    // ── Strategy 1: ROPC (fast, no browser) ──────────────────────────────
    let token = null;
    let ropcResult = null;
    let hasBrowserStorageState = false;
    if (ropcEnabled) {
      try {
        ropcResult = await acquireTokenByROPC(role);
        if (ropcResult) {
          token = ropcResult.accessToken;
          console.log(`[refresh-playwright-tokens] ${role.name}: acquired via ROPC (no browser needed)`);
        }
      } catch (ropcError) {
        const reason = ropcError instanceof Error ? ropcError.message : String(ropcError);
        console.warn(`[refresh-playwright-tokens] ${role.name}: ROPC failed, falling back to browser: ${reason}`);
      }
    }

    // ── Strategy 2: Browser login for real storageState (preferred for browser suites) ──
    // Always attempt browser login to capture real MSAL v5 encrypted storage state.
    // ROPC token is kept for API tests even if browser capture fails.
    {
      try {
        const browserToken = await loginAndCaptureWithTimeout({
          username: role.username,
          password: role.password,
          name: role.name,
          statePath: role.statePath,
        });
        hasBrowserStorageState = true;
        if (!token) {
          token = browserToken;
        }
        console.log(`[refresh-playwright-tokens] ${role.name}: captured browser storage state`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!token) {
          if (!softSkip) {
            throw error;
          }
          console.warn(`[refresh-playwright-tokens] skipped ${role.name}: ${reason}`);
        } else {
          if (ropcResult && appOrigin) {
            try {
              const syntheticState = buildSyntheticStorageState(ropcResult, appOrigin);
              fs.writeFileSync(role.statePath, JSON.stringify(syntheticState, null, 2), 'utf8');
              hasBrowserStorageState = true;
              console.warn(`[refresh-playwright-tokens] ${role.name}: browser storage capture failed; wrote synthetic MSAL storage state fallback: ${reason}`);
            } catch (writeError) {
              const writeReason = writeError instanceof Error ? writeError.message : String(writeError);
              console.warn(`[refresh-playwright-tokens] ${role.name}: failed to write synthetic storage fallback (${writeReason}); retaining token-only auth state path: ${reason}`);
            }
          } else {
            console.warn(`[refresh-playwright-tokens] ${role.name}: browser storage capture failed, retaining token-only auth state path: ${reason}`);
          }
        }
      }
    }

    if (token) {
      exportToken(role.tokenEnv, token);
      refreshedCount += 1;
      console.log(`[refresh-playwright-tokens] refreshed ${role.tokenEnv} → ${path.relative(process.cwd(), role.statePath)}`);
    }
  }

  if (refreshedCount === 0) {
    failOrSkip('Could not refresh any Playwright role tokens.');
  }
}

main().catch((error) => {
  console.error('[refresh-playwright-tokens] failed', error);
  process.exit(1);
});
