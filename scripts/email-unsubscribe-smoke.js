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
const expectedOutcomes = (process.env.EMAIL_EXPECTED_LOG_OUTCOMES || 'invalid_token,unsubscribed,already_unsubscribed')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const contractRetryAttempts = Number.parseInt(process.env.EMAIL_CONTRACT_RETRY_ATTEMPTS || '6', 10);
const contractRetryDelayMs = Number.parseInt(process.env.EMAIL_CONTRACT_RETRY_DELAY_MS || '10000', 10);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runContractChecks() {
  const checks = [];

  let invalid = null;
  let attempt = 0;
  const maxAttempts = Number.isFinite(contractRetryAttempts) && contractRetryAttempts > 0 ? contractRetryAttempts : 6;
  const delayMs = Number.isFinite(contractRetryDelayMs) && contractRetryDelayMs > 0 ? contractRetryDelayMs : 10000;

  for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
    invalid = await getText('/api/v1/preferences/email/unsubscribe/not-a-real-token');
    const bodyLower = String(invalid.body || '').toLowerCase();
    const bodySnippet = String(invalid.body || '').replace(/\s+/g, ' ').slice(0, 180);
    checks.push([`unsubscribe_invalid_status_attempt_${attempt}`, invalid.status]);
    checks.push([`unsubscribe_invalid_body_attempt_${attempt}`, bodySnippet]);

    if (invalid.status === 400 && bodyLower.includes('invalid or expired')) {
      break;
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  const finalBodyLower = String(invalid?.body || '').toLowerCase();
  checks.push(['unsubscribe_invalid_attempts', attempt]);
  checks.push(['unsubscribe_invalid_status', invalid?.status ?? 'unknown']);
  checks.push(['unsubscribe_invalid_contains', finalBodyLower.includes('invalid or expired') ? 'yes' : 'no']);

  assert(invalid?.status === 400, 'Invalid unsubscribe token should return 400.');
  assert(finalBodyLower.includes('invalid or expired'), 'Invalid unsubscribe response should mention invalid/expired link.');

  if (adminBearerToken) {
    const logs = await getJson('/api/v1/preferences/email/logs?limit=10', {
      Authorization: `Bearer ${adminBearerToken}`,
    });
    checks.push(['admin_email_logs_status', logs.status]);
    checks.push(['admin_email_logs_body', JSON.stringify(logs.body)]);

    assert(logs.status === 200, 'Admin email preference logs endpoint should return 200.');
    assert(Array.isArray(logs.body.rows), 'Admin email preference logs response should include rows[].');

    const hasExpected = logs.body.rows.some(
      (row) => row && typeof row.outcome === 'string' && expectedOutcomes.includes(row.outcome)
    );
    checks.push(['admin_email_logs_expected_outcome', hasExpected ? 'yes' : 'no']);
    assert(hasExpected, `Expected at least one email log outcome in [${expectedOutcomes.join(', ')}].`);
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

  if (adminBearerToken) {
    const logs = await getJson('/api/v1/preferences/email/logs?limit=25', {
      Authorization: `Bearer ${adminBearerToken}`,
    });
    checks.push(['live_admin_email_logs_status', logs.status]);
    checks.push(['live_admin_email_logs_body', JSON.stringify(logs.body)]);
    assert(logs.status === 200, 'Live admin email preference logs endpoint should return 200.');
    assert(Array.isArray(logs.body.rows), 'Live admin email logs should include rows[].');

    const liveOutcomeExists = logs.body.rows.some(
      (row) => row && (row.outcome === 'unsubscribed' || row.outcome === 'already_unsubscribed')
    );
    checks.push(['live_admin_email_logs_outcome_match', liveOutcomeExists ? 'yes' : 'no']);
    assert(liveOutcomeExists, 'Expected live unsubscribe outcome in email preference logs.');
  }

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
