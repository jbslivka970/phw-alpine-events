#!/usr/bin/env node

/**
 * Tokenized RSVP smoke checks.
 *
 * Modes:
 * 1) Contract mode (default): validates invalid-token behavior safely.
 * 2) Live mode (optional): validates GET/POST with a known RSVP token.
 *
 * Environment variables:
 * - BACKEND_BASE_URL: API origin, example https://phwalpineeventsjb873a.azurewebsites.net
 * - RSVP_TEST_ENABLE_LIVE: set to 1 to run live checks
 * - RSVP_TEST_TOKEN: signed RSVP token for live mode
 * - RSVP_TEST_RESPONSE: response for live POST (default yes)
 * - RSVP_TEST_RESPONSE_ROLE: optional role for live POST (MENTOR or PARTICIPANT)
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const liveMode = process.env.RSVP_TEST_ENABLE_LIVE === '1';
const rsvpToken = process.env.RSVP_TEST_TOKEN || '';
const liveResponse = (process.env.RSVP_TEST_RESPONSE || 'yes').toLowerCase();
const liveResponseRole = (process.env.RSVP_TEST_RESPONSE_ROLE || '').toUpperCase();

function url(path) {
  return `${backendBaseUrl}${path}`;
}

async function getJson(path) {
  const response = await fetch(url(path), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text() };
  }

  return { status: response.status, body };
}

async function postJson(path, payload) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  const invalidGet = await getJson('/api/v1/events/rsvp/not-a-real-token');
  checks.push(['rsvp_invalid_get_status', invalidGet.status]);
  checks.push(['rsvp_invalid_get_body', JSON.stringify(invalidGet.body)]);
  assert(invalidGet.status === 401, 'Invalid RSVP token GET should return 401.');

  const invalidPost = await postJson('/api/v1/events/rsvp/not-a-real-token', { response: 'yes' });
  checks.push(['rsvp_invalid_post_status', invalidPost.status]);
  checks.push(['rsvp_invalid_post_body', JSON.stringify(invalidPost.body)]);
  assert(invalidPost.status === 401, 'Invalid RSVP token POST should return 401.');

  return checks;
}

async function runLiveChecks() {
  if (!rsvpToken) {
    throw new Error('RSVP_TEST_TOKEN is required when RSVP_TEST_ENABLE_LIVE=1.');
  }

  const checks = [];

  const liveGet = await getJson(`/api/v1/events/rsvp/${encodeURIComponent(rsvpToken)}`);
  checks.push(['rsvp_live_get_status', liveGet.status]);
  checks.push(['rsvp_live_get_has_event', liveGet.body && liveGet.body.event_id ? 'yes' : 'no']);
  assert(liveGet.status === 200, 'Live RSVP token GET should return 200.');
  assert(Boolean(liveGet.body?.event_id), 'Live RSVP GET response should include event_id.');

  const postPayload = {
    response: liveResponse,
    ...(liveResponseRole === 'MENTOR' || liveResponseRole === 'PARTICIPANT' ? { response_role: liveResponseRole } : {}),
  };

  const livePost = await postJson(`/api/v1/events/rsvp/${encodeURIComponent(rsvpToken)}`, postPayload);
  checks.push(['rsvp_live_post_status', livePost.status]);
  checks.push(['rsvp_live_post_response', livePost.body?.response ?? null]);
  assert(livePost.status === 200, 'Live RSVP token POST should return 200.');
  assert(livePost.body?.response === liveResponse, 'Live RSVP POST response should match submitted response.');

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
