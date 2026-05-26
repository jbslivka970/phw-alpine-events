#!/usr/bin/env node

const backendBaseUrl = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const bearerToken = (process.env.GUEST_ASSIGNMENTS_SMOKE_TOKEN || process.env.PW_ADMIN_TOKEN || '').trim();
const configuredEventId = (process.env.GUEST_ASSIGNMENTS_SMOKE_EVENT_ID || '').trim();

if (!backendBaseUrl) {
  console.error('BACKEND_BASE_URL is required');
  process.exit(1);
}

if (!bearerToken) {
  console.error('PW_ADMIN_TOKEN or GUEST_ASSIGNMENTS_SMOKE_TOKEN is required');
  process.exit(1);
}

function buildUrl(path) {
  return `${backendBaseUrl}${path}`;
}

async function getJson(path) {
  const response = await fetch(buildUrl(path), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  return { response, body };
}

function findEventId(body) {
  if (!Array.isArray(body)) {
    return '';
  }

  const preferred = body.find((item) => item && typeof item.event_id === 'string' && item.status === 'published');
  if (preferred?.event_id) {
    return preferred.event_id;
  }

  const fallback = body.find((item) => item && typeof item.event_id === 'string');
  return fallback?.event_id || '';
}

async function main() {
  const startedAt = Date.now();
  let eventId = configuredEventId;

  if (!eventId) {
    const eventsResult = await getJson('/api/v1/events');
    console.log(`events_status=${eventsResult.response.status}`);
    if (!eventsResult.response.ok) {
      console.error(`Unable to list events for guest assignment smoke (HTTP ${eventsResult.response.status})`);
      process.exit(1);
    }

    eventId = findEventId(eventsResult.body);
    if (!eventId) {
      console.log('guest_assignments_result=SKIP');
      console.log('guest_assignments_reason=no_event_id_available');
      console.log(`duration_ms=${Date.now() - startedAt}`);
      return;
    }
  }

  const guestAssignmentsResult = await getJson(`/api/v1/events/${encodeURIComponent(eventId)}/guest-assignments`);
  console.log(`guest_assignments_event_id=${eventId}`);
  console.log(`guest_assignments_status=${guestAssignmentsResult.response.status}`);
  console.log(`duration_ms=${Date.now() - startedAt}`);

  if (!guestAssignmentsResult.response.ok) {
    console.error(`Guest assignments endpoint returned HTTP ${guestAssignmentsResult.response.status}`);
    console.error(`guest_assignments_body=${JSON.stringify(guestAssignmentsResult.body)}`);
    process.exit(1);
  }

  if (!Array.isArray(guestAssignmentsResult.body)) {
    console.error('Guest assignments response is not an array');
    process.exit(1);
  }

  console.log(`guest_assignments_count=${guestAssignmentsResult.body.length}`);
  console.log('guest_assignments_result=PASS');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});