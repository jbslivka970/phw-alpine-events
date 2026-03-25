#!/usr/bin/env node

/**
 * SMS inbound compliance smoke checks.
 *
 * Modes:
 * 1) Contract mode (default): safe checks with non-member phone number.
 * 2) Live mode (optional): run HELP/RSVP against a known test member phone.
 * 3) STOP mode (optional and destructive): toggles sms_opt_in=false for test member.
 *
 * Environment variables:
 * - BACKEND_BASE_URL: API origin, example https://phwalpineeventsjb873a.azurewebsites.net
 * - SMS_NON_MEMBER_PHONE: fake phone for safe checks (default +15555550199)
 * - SMS_TEST_PHONE: real test member phone (E.164) for live checks
 * - SMS_TEST_ENABLE_LIVE: set to 1 to run live checks against SMS_TEST_PHONE
 * - SMS_TEST_ENABLE_STOP: set to 1 to include STOP test (destructive)
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const nonMemberPhone = process.env.SMS_NON_MEMBER_PHONE || '+15555550199';
const testPhone = process.env.SMS_TEST_PHONE || '';
const liveMode = process.env.SMS_TEST_ENABLE_LIVE === '1';
const stopMode = process.env.SMS_TEST_ENABLE_STOP === '1';

function url(path) {
  return `${backendBaseUrl}${path}`;
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

  const validationPayload = [
    {
      eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent',
      data: { validationCode: 'smoke-validation-code' },
    },
  ];
  const validation = await postJson('/api/v1/sms/inbound', validationPayload);
  checks.push(['eventgrid_validation_status', validation.status]);
  checks.push(['eventgrid_validation_body', JSON.stringify(validation.body)]);
  assert(validation.status === 200, 'Event Grid validation should return 200.');
  assert(
    validation.body && validation.body.validationResponse === 'smoke-validation-code',
    'Event Grid validation response body mismatch.'
  );

  const batchPayload = [
    {
      eventType: 'Microsoft.Communication.SMSReceived',
      data: { from: nonMemberPhone, message: 'HELP' },
    },
  ];
  const batch = await postJson('/api/v1/sms/inbound', batchPayload);
  checks.push(['eventgrid_batch_status', batch.status]);
  checks.push(['eventgrid_batch_body', JSON.stringify(batch.body)]);
  assert(batch.status === 200, 'Event Grid batch payload should return 200.');
  assert(Array.isArray(batch.body.processed), 'Event Grid batch should return processed[] array.');

  const help = await postJson('/api/v1/sms/inbound', { from: nonMemberPhone, message: 'HELP' });
  checks.push(['help_unknown_status', help.status]);
  checks.push(['help_unknown_body', JSON.stringify(help.body)]);
  assert(help.status === 200, 'HELP (unknown phone) should return 200.');
  assert(help.body.status === 'ignored', 'HELP (unknown phone) should be ignored with safe reply.');

  const unknownCommand = await postJson('/api/v1/sms/inbound', { from: nonMemberPhone, message: 'ZZZ' });
  checks.push(['unknown_command_status', unknownCommand.status]);
  checks.push(['unknown_command_body', JSON.stringify(unknownCommand.body)]);
  assert(unknownCommand.status === 200, 'Unknown command should return 200.');
  assert(unknownCommand.body.status === 'ignored', 'Unknown command for non-member should be ignored.');

  return checks;
}

async function runLiveChecks() {
  if (!testPhone) {
    throw new Error('SMS_TEST_PHONE is required when SMS_TEST_ENABLE_LIVE=1.');
  }

  const checks = [];

  const help = await postJson('/api/v1/sms/inbound', { from: testPhone, message: 'HELP' });
  checks.push(['live_help_status', help.status]);
  checks.push(['live_help_body', JSON.stringify(help.body)]);
  assert(help.status === 200, 'Live HELP should return 200.');

  const rsvp = await postJson('/api/v1/sms/inbound', { from: testPhone, message: 'Y 1' });
  checks.push(['live_rsvp_status', rsvp.status]);
  checks.push(['live_rsvp_body', JSON.stringify(rsvp.body)]);
  assert(rsvp.status === 200, 'Live RSVP parsing call should return 200.');

  if (stopMode) {
    const stop = await postJson('/api/v1/sms/inbound', { from: testPhone, message: 'STOP' });
    checks.push(['live_stop_status', stop.status]);
    checks.push(['live_stop_body', JSON.stringify(stop.body)]);
    assert(stop.status === 200, 'Live STOP should return 200.');
    assert(stop.body.status === 'opted_out', 'Live STOP should return opted_out status.');
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
    allChecks.push(['stop_mode', stopMode]);

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
