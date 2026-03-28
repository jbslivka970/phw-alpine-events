import { chromium } from 'playwright';

const appUrl = process.env.APP_URL || 'https://phwalpineeventsfe873a.azurewebsites.net';
const username = process.env.USER_USER;
const password = process.env.USER_PASS;

async function fillIfVisible(page, selectors, value) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
}

function getScopes(page) {
  return [page, ...page.frames()];
}

async function fillInAnyScope(page, selectors, value) {
  for (const scope of getScopes(page)) {
    if (await fillIfVisible(scope, selectors, value)) {
      return true;
    }
  }
  return false;
}

async function clickIfVisible(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click();
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

async function login(page) {
  await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' });
  const signInButton = page.getByRole('button', { name: /sign in/i });
  const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  await signInButton.click();
  const popup = await popupPromise;
  const authPage = popup || page;

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
      break;
    }
    await clickInAnyScope(authPage, [
      'button:has-text("Use another account")',
      'a:has-text("Use another account")',
      'button:has-text("Continue")',
    ]);
    await authPage.waitForTimeout(800);
  }

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
      break;
    }
    await authPage.waitForTimeout(800);
  }

  await clickInAnyScope(authPage, [
    'button:has-text("No")',
    'button:has-text("Yes")',
    'button:has-text("Accept")',
    'button:has-text("Continue")',
    'input[type="submit"]#idSIButton9',
    'button[type="submit"]',
  ]);

  if (popup) {
    await popup.waitForEvent('close', { timeout: 30000 }).catch(() => {});
  }

  await page.waitForURL(/\/dashboard|\/events|\/tavf|\/$/, { timeout: 90000 });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

await login(page);
console.log('post-login:', page.url());

await page.goto(`${appUrl}/tavf/new`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2000);
console.log('direct tavf/new:', page.url());

await page.goto(`${appUrl}/tavf`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2000);
console.log('tavf page:', page.url());

const newPostingLinkVisible = await page.locator('a[href="/tavf/new"]').first().isVisible().catch(() => false);
console.log('new posting link visible:', newPostingLinkVisible);

await page.screenshot({ path: './tmp-user-tavf-debug.png', fullPage: true });

await context.close();
await browser.close();
