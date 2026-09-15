#!/usr/bin/env node

const apiKey = process.env.TELNYX_API_KEY?.trim();
const to = process.env.SMS_TEST_PHONE?.trim();
const from = process.env.TELNYX_FROM_NUMBER?.trim();
const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID?.trim();
const commitRef = (process.env.SMS_TEST_COMMIT_REF || process.env.GITHUB_SHA || 'local-smoke').slice(0, 12).toLowerCase();
const pollAttempts = Number.parseInt(process.env.TELNYX_SMOKE_POLL_ATTEMPTS || '18', 10);
const pollIntervalMs = Number.parseInt(process.env.TELNYX_SMOKE_POLL_INTERVAL_MS || '5000', 10);

function requireValue(name, value) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function telnyxRequest(path, options = {}) {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  if (!response.ok) {
    throw new Error(`Telnyx API ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  requireValue('TELNYX_API_KEY', apiKey);
  requireValue('SMS_TEST_PHONE', to);
  requireValue('TELNYX_FROM_NUMBER', from);
  requireValue('TELNYX_MESSAGING_PROFILE_ID', messagingProfileId);

  const text = `PHW Alpine deployment smoke ${commitRef}`;
  const sent = await telnyxRequest('/messages', {
    method: 'POST',
    body: JSON.stringify({
      to,
      from,
      messaging_profile_id: messagingProfileId,
      text,
    }),
  });
  const messageId = sent.data?.id;
  if (!messageId) {
    throw new Error('Telnyx send response did not include a message id.');
  }

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const statusResponse = await telnyxRequest(`/messages/${encodeURIComponent(messageId)}`);
    const message = statusResponse.data || {};
    const status = message.to?.[0]?.status || message.status || 'unknown';
    console.log(`message_id=${messageId}`);
    console.log(`attempt=${attempt}`);
    console.log(`status=${status}`);
    console.log(`to=${to}`);

    if (status === 'delivered') {
      console.log('result=PASS');
      return;
    }
    if (status === 'failed' || status === 'delivery_failed') {
      throw new Error(`Telnyx reported delivery failure for ${messageId}.`);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for Telnyx message ${messageId} to become delivered.`);
}

run().catch((error) => {
  console.error(`result=FAIL`);
  console.error(`error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
