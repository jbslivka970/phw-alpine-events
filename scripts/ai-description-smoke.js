#!/usr/bin/env node

/**
 * AI description smoke checks.
 *
 * Modes:
 * 1) Contract mode (default): validates auth behavior safely.
 * 2) Live mode (optional): calls AI description preview with an authenticated token.
 *
 * Environment variables:
 * - BACKEND_BASE_URL: API origin, example https://phwalpineeventsjb873a.azurewebsites.net
 * - AI_TEST_ENABLE_LIVE: set to 1 to run authenticated live check
 * - AI_TEST_AUTH_TOKEN: bearer token with event creator/admin capability
 * - AI_TEST_EXPECT_PROVIDER: provider expected in live mode (default azure-openai)
 * - AI_TEST_ALLOW_FALLBACK: set to 1 to allow provider=fallback in live mode
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const liveMode = process.env.AI_TEST_ENABLE_LIVE === '1';
const authToken = process.env.AI_TEST_AUTH_TOKEN || '';
const expectedProvider = (process.env.AI_TEST_EXPECT_PROVIDER || 'azure-openai').trim();
const allowFallback = process.env.AI_TEST_ALLOW_FALLBACK === '1';

function url(path) {
  return `${backendBaseUrl}${path}`;
}

async function postJson(path, payload, headers = {}) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
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

  const unauthenticated = await postJson('/api/v1/events/ai-description-preview', {
    title: 'Smoke Event',
    event_date: new Date().toISOString(),
    location: 'Boulder Creek',
    description: 'Contract smoke description',
    tone: 'friendly',
  });

  checks.push(['ai_description_unauth_status', unauthenticated.status]);
  checks.push(['ai_description_unauth_body', JSON.stringify(unauthenticated.body)]);
  assert(unauthenticated.status === 401, 'Unauthenticated AI description preview should return 401.');

  return checks;
}

async function runLiveChecks() {
  if (!authToken) {
    throw new Error('AI_TEST_AUTH_TOKEN is required when AI_TEST_ENABLE_LIVE=1.');
  }

  const checks = [];

  const response = await postJson(
    '/api/v1/events/ai-description-preview',
    {
      title: 'Smoke Event AI Description',
      event_date: new Date().toISOString(),
      location: 'Blue River Campground',
      description: 'Testing that AI provider returns polished copy and does not silently fall back.',
      tone: 'friendly',
    },
    {
      Authorization: `Bearer ${authToken}`,
    }
  );

  checks.push(['ai_description_live_status', response.status]);
  checks.push(['ai_description_live_provider', response.body?.provider ?? null]);
  checks.push([
    'ai_description_live_has_polished_description',
    typeof response.body?.polished_description === 'string' && response.body.polished_description.trim().length > 0 ? 'yes' : 'no',
  ]);

  assert(response.status === 200, 'Authenticated AI description preview should return 200.');
  assert(
    typeof response.body?.polished_description === 'string' && response.body.polished_description.trim().length > 0,
    'AI description preview should return polished_description.'
  );

  const provider = response.body?.provider;
  if (!allowFallback) {
    assert(provider !== 'fallback', 'AI provider should not be fallback in live mode.');
  }
  if (expectedProvider.length > 0) {
    assert(provider === expectedProvider, `Expected AI provider ${expectedProvider}, received ${provider}.`);
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
    allChecks.push(['expected_provider', expectedProvider]);
    allChecks.push(['allow_fallback', allowFallback]);

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
