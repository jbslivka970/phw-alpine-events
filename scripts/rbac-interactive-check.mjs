import { chromium } from 'playwright';

const appUrl = process.env.APP_URL || 'https://phwalpineeventsfe873a.azurewebsites.net';

const accounts = [
  {
    role: 'ADMIN',
    username: process.env.ADMIN_USER,
    password: process.env.ADMIN_PASS,
    expect: {
      navAdmin: true,
      tavfNewAllowed: false,
      adminAllowed: true,
      eventCreateAllowed: true,
    },
  },
  {
    role: 'EVENT_CREATOR',
    username: process.env.CREATOR_USER,
    password: process.env.CREATOR_PASS,
    expect: {
      navAdmin: false,
      tavfNewAllowed: true,
      adminAllowed: false,
      eventCreateAllowed: true,
    },
  },
  {
    role: 'USER',
    username: process.env.USER_USER,
    password: process.env.USER_PASS,
    expect: {
      navAdmin: false,
      tavfNewAllowed: true,
      adminAllowed: false,
      eventCreateAllowed: false,
    },
  },
].filter((a) => a.username && a.password);

if (accounts.length !== 3) {
  console.error('Missing required env vars: ADMIN_USER, ADMIN_PASS, CREATOR_USER, CREATOR_PASS, USER_USER, USER_PASS');
  process.exit(1);
}

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

    await authPage.waitForTimeout(1000);
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

    await authPage.waitForTimeout(1000);
  }

  return false;
}

async function navigateAndGetSettledUrl(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  return page.url();
}

async function clickAndGetSettledUrl(page, locator) {
  await locator.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  return page.url();
}

async function login(page, username, password, role) {
  await page.goto(`${appUrl}/login`, { waitUntil: 'domcontentloaded' });

  const signInButton = page.getByRole('button', { name: /sign in/i });
  if (!(await signInButton.isVisible().catch(() => false))) {
    throw new Error(`${role}: Sign in button not visible on /login`);
  }

  const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  await signInButton.click();
  const popup = await popupPromise;
  const authPage = popup || page;
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});

  const filledUser = await completeUsernameStep(authPage, username);
  if (!filledUser) {
    await authPage.screenshot({ path: `./tmp-rbac-${role.toLowerCase()}-auth-username.png`, fullPage: true }).catch(() => {});
    throw new Error(`${role}: Could not find username/email input in auth popup`);
  }

  await authPage.waitForLoadState('domcontentloaded').catch(() => {});

  const filledPass = await completePasswordStep(authPage, password);
  if (!filledPass) {
    await authPage.screenshot({ path: `./tmp-rbac-${role.toLowerCase()}-auth-password.png`, fullPage: true }).catch(() => {});
    throw new Error(`${role}: Could not find password input in auth popup`);
  }

  // Handle common consent/stay signed in prompts if shown.
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
    await popup.waitForEvent('close', { timeout: 30000 }).catch(() => {});
  }

  // Wait for app to navigate after popup auth.
  await page.waitForURL(/\/dashboard|\/events|\/tavf|\/$/, { timeout: 90000 });
}

async function runForAccount(account) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const result = {
    role: account.role,
    login: false,
    checks: {},
    mismatches: [],
    errors: [],
  };

  try {
    await login(page, account.username, account.password, account.role);
    result.login = true;

    const roleClaims = await page.evaluate(() => {
      const values = [];
      const keys = Object.keys(window.sessionStorage).filter((key) => key.includes('msal') && key.includes('account'));
      for (const key of keys) {
        try {
          const parsed = JSON.parse(window.sessionStorage.getItem(key) ?? '{}');
          const claims = parsed?.idTokenClaims ?? {};
          const raw = [
            claims.roles,
            claims.role,
            claims.extension_Roles,
            claims.extension_roles,
            claims.app_roles,
            claims.appRoles,
          ];
          for (const item of raw) {
            if (typeof item === 'string') {
              values.push(item);
            } else if (Array.isArray(item)) {
              for (const value of item) {
                if (typeof value === 'string') {
                  values.push(value);
                }
              }
            }
          }
        } catch {
          // Ignore malformed cache entries.
        }
      }
      return Array.from(new Set(values));
    });
    result.checks.roleClaims = roleClaims;

    const displayedUserLabel = await page.locator('.phw-layout__user span').first().textContent().catch(() => null);
    result.checks.displayedUser = displayedUserLabel?.trim() ?? null;

    const adminNavVisible = await page.locator('a[href="/admin"]').first().isVisible().catch(() => false);
    result.checks.adminNavVisible = adminNavVisible;
    result.checks.adminNavExpected = account.expect.navAdmin;

    let tavfNewUrl = page.url();
    const tavfNav = page.locator('a[href="/tavf"]').first();
    const tavfNavVisible = await tavfNav.isVisible().catch(() => false);
    result.checks.tavfNavVisible = tavfNavVisible;
    if (tavfNavVisible) {
      result.checks.tavfNavUrl = await clickAndGetSettledUrl(page, tavfNav);
    } else {
      result.checks.tavfNavUrl = page.url();
    }

    const tavfCreateAction = page.locator('a[href="/tavf/new"], button:has-text("New Posting"), a:has-text("Create the first posting")').first();
    const tavfCreateVisible = await tavfCreateAction.isVisible().catch(() => false);
    result.checks.tavfCreateActionVisible = tavfCreateVisible;
    const tavfDomDiagnostics = await page.evaluate(() => {
      const header = document.querySelector('.page-header');
      const createLink = document.querySelector('a[href="/tavf/new"]');
      return {
        headerText: header?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        hasCreateLinkInDom: Boolean(createLink),
      };
    });
    result.checks.tavfHeaderText = tavfDomDiagnostics.headerText;
    result.checks.tavfCreateLinkInDom = tavfDomDiagnostics.hasCreateLinkInDom;
    if (tavfCreateVisible) {
      tavfNewUrl = await clickAndGetSettledUrl(page, tavfCreateAction);
    } else {
      tavfNewUrl = page.url();
    }
    result.checks.tavfNewUrl = tavfNewUrl;
    result.checks.tavfNewAllowed = /\/tavf\/new(\?|$)/.test(tavfNewUrl);
    result.checks.tavfNewExpected = account.expect.tavfNewAllowed;

    let adminUrl = page.url();
    const adminNav = page.locator('a[href="/admin"]').first();
    if (await adminNav.isVisible().catch(() => false)) {
      adminUrl = await clickAndGetSettledUrl(page, adminNav);
    }
    result.checks.adminUrl = adminUrl;
    result.checks.adminAllowed = /\/admin(\?|$)/.test(adminUrl);
    result.checks.adminExpected = account.expect.adminAllowed;

    let eventsUrl = page.url();
    const eventsNav = page.locator('a[href="/events"]').first();
    if (await eventsNav.isVisible().catch(() => false)) {
      eventsUrl = await clickAndGetSettledUrl(page, eventsNav);
    }
    result.checks.eventsUrl = eventsUrl;
    result.checks.eventsPageLoaded = /\/events(\?|$)/.test(eventsUrl);

    const eventCreateVisible = await page.getByRole('button', { name: /new event/i }).isVisible().catch(() => false);
    result.checks.eventCreateVisible = eventCreateVisible;
    result.checks.eventCreateExpected = account.expect.eventCreateAllowed;

    if (result.checks.adminNavVisible !== result.checks.adminNavExpected) {
      result.mismatches.push(`adminNavVisible expected ${result.checks.adminNavExpected} but got ${result.checks.adminNavVisible}`);
    }

    if (result.checks.tavfNewAllowed !== result.checks.tavfNewExpected) {
      result.mismatches.push(`tavfNewAllowed expected ${result.checks.tavfNewExpected} but got ${result.checks.tavfNewAllowed}`);
    }

    if (result.checks.adminAllowed !== result.checks.adminExpected) {
      result.mismatches.push(`adminAllowed expected ${result.checks.adminExpected} but got ${result.checks.adminAllowed}`);
    }

    if (!result.checks.eventsPageLoaded) {
      result.mismatches.push(`eventsPageLoaded expected true but got ${result.checks.eventsPageLoaded}`);
    }

    if (result.checks.eventCreateVisible !== result.checks.eventCreateExpected) {
      result.mismatches.push(`eventCreateVisible expected ${result.checks.eventCreateExpected} but got ${result.checks.eventCreateVisible}`);
    }

    const signOut = page.getByRole('button', { name: /sign out/i });
    if (await signOut.isVisible().catch(() => false)) {
      await signOut.click();
      await page.waitForURL(/\/login/, { timeout: 30000 }).catch(() => {});
    }
  } catch (err) {
    result.errors.push(String(err));
    await page.screenshot({ path: `./tmp-rbac-${account.role.toLowerCase()}-error.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }

  return result;
}

const output = [];
for (const account of accounts) {
  // eslint-disable-next-line no-await-in-loop
  const result = await runForAccount(account);
  output.push(result);
}

console.log(JSON.stringify({ appUrl, output }, null, 2));

const hasError = output.some((r) => !r.login || r.errors.length > 0 || r.mismatches.length > 0);
if (hasError) {
  process.exit(2);
}
