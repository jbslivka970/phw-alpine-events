#!/usr/bin/env node

/**
 * Email unsubscribe compliance smoke checks.
 *
 * Modes:
 * 1) Contract mode (default): validates invalid-token behavior safely.
 * 2) Live mode (optional and destructive): executes an actual unsubscribe token.
 *
 * Environment variables:
 * - BACKEND_BASE_URL: API origin, example https://phwalpineeventsjb873a.azurewebsites.net
 * - EMAIL_TEST_ENABLE_LIVE: set to 1 to run live unsubscribe check
 * - EMAIL_UNSUBSCRIBE_TOKEN: signed unsubscribe token for live mode
 * - EMAIL_ADMIN_BEARER_TOKEN: optional admin JWT to verify /api/v1/preferences/email/logs
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const liveMode = process.env.EMAIL_TEST_ENABLE_LIVE === '1';
const unsubscribeToken = process.env.EMAIL_UNSUBSCRIBE_TOKEN || '';
const adminBearerToken = process.env.EMAIL_ADMIN_BEARER_TOKEN || '';

function url(path) {
  return `${backendBaseUrl}${path}`;
}

async function getText(path, headers = {}) {
  const response = await fetch(url(path), {
    method: 'GET',
    headers,
  });

  return {
    status: response.status,
    body: await response.text(),
  };
}

async function getJson(path, headers = {}) {
  const response = await fetch(url(path), {
    method: 'GET',
    headers,
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text() };
  }

  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runContractChecks() {
  const checks = [];

  const invalid = await getText('/api/v1/preferences/email/unsubscribe/not-a-real-token');
  checks.push(['unsubscribe_invalid_status', invalid.status]);
  checks.push(['unsubscribe_invalid_contains', invalid.body.toLowerCase().includes('invalid or expired') ? 'yes' : 'no']);

  assert(invalid.status === 400, 'Invalid unsubscribe token should return 400.');
  assert(invalid.body.toLowerCase().includes('invalid or expired'), 'Invalid unsubscribe response should mention invalid/expired link.');

  if (adminBearerToken) {
    const logs = await getJson('/api/v1/preferences/email/logs?limit=10', {
      Authorization: `Bearer ${adminBearerToken}`,
    });
    checks.push(['admin_email_logs_status', logs.status]);
    checks.push(['admin_email_logs_body', JSON.stringify(logs.body)]);

    assert(logs.status === 200, 'Admin email preference logs endpoint should return 200.');
    assert(Array.isArray(logs.body.rows), 'Admin email preference logs response should include rows[].');
  }

  return checks;
}

async function runLiveChecks() {
  if (!unsubscribeToken) {
    throw new Error('EMAIL_UNSUBSCRIBE_TOKEN is required when EMAIL_TEST_ENABLE_LIVE=1.');
  }

  const checks = [];
  const live = await getText(`/api/v1/preferences/email/unsubscribe/${encodeURIComponent(unsubscribeToken)}`);
  checks.push(['live_unsubscribe_status', live.status]);
  checks.push([
    'live_unsubscribe_contains',
    live.body.toLowerCase().includes('unsubscribed') || live.body.toLowerCase().includes('already unsubscribed') ? 'yes' : 'no',
  ]);

  assert(live.status === 200, 'Live unsubscribe token should return 200.');
  assert(
    live.body.toLowerCase().includes('unsubscribed') || live.body.toLowerCase().includes('already unsubscribed'),
    'Live unsubscribe response should confirm unsubscribed status.'
  );

  return checks;
}

(async () => {
  const started = new Date().toISOString();
  const allChecks = [];

  try {
    allChecks.push(['started_at', started]);
    allChecks.push(['backend_base_url', backendBaseUrl]);
    allChecks.push(['live_mode', liveMode]);

    const contractChecks = await runContractChecks();
    allChecks.push(...contractChecks);

    if (liveMode) {
      const liveChecks = await runLiveChecks();
      allChecks.push(...liveChecks);
    }

    allChecks.push(['result', 'PASS']);
    for (const [key, value] of allChecks) {
      console.log(`${key}=${value}`);
    }
  } catch (error) {
    allChecks.push(['result', 'FAIL']);
    for (const [key, value] of allChecks) {
      console.log(`${key}=${value}`);
    }
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();
