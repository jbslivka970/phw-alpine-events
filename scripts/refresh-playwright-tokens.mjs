#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = new Set(process.argv.slice(2));
const softSkip = args.has('--soft-skip');
const tokenEnvFile = (process.env.PW_TOKEN_ENV_FILE || '').trim();

const appUrl = (process.env.E2E_APP_URL || '').trim().replace(/\/$/, '');
const authDir = path.resolve(process.cwd(), 'tests/e2e/.auth');

const roles = [
  {
    name: 'admin',
    username: process.env.PW_ADMIN_USER,
    password: process.env.PW_ADMIN_PASS,
    tokenEnv: 'PW_ADMIN_TOKEN',
    statePath: path.join(authDir, 'admin.json'),
  },
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
];

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

async function completeUsernameStep(authPage, username) {
  for (let i = 0; i < 45; i += 1) {
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

async function completePasswordStep(authPage, password) {
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

async function loginAndCapture({ username, password, statePath }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

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
      await popup.waitForEvent('close', { timeout: 30_000 }).catch(() => {});
    }

    await page.waitForURL(/\/dashboard|\/events|\/tavf|\/$/, { timeout: 90_000 });
    await page.waitForTimeout(1200);

    const token = await page.evaluate(() => {
      const sources = [window.sessionStorage, window.localStorage];
      for (const source of sources) {
        for (const key of Object.keys(source)) {
          if (!key.toLowerCase().includes('accesstoken')) {
            continue;
          }
          try {
            const parsed = JSON.parse(source.getItem(key) ?? '{}');
            if (typeof parsed.secret === 'string' && parsed.secret.length > 20) {
              return parsed.secret;
            }
          } catch {
            // Ignore malformed cache entries.
          }
        }
      }
      return null;
    });

    if (!token) {
      throw new Error('Could not extract access token from MSAL cache.');
    }

    await context.storageState({ path: statePath });
    return token;
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

  for (const role of configuredRoles) {
    console.log(`[refresh-playwright-tokens] logging in ${role.name}...`);
    const token = await loginAndCapture({
      username: role.username,
      password: role.password,
      statePath: role.statePath,
    });
    exportToken(role.tokenEnv, token);
    console.log(`[refresh-playwright-tokens] refreshed ${role.tokenEnv} and wrote ${path.relative(process.cwd(), role.statePath)}`);
  }
}

main().catch((error) => {
  console.error('[refresh-playwright-tokens] failed', error);
  process.exit(1);
});
