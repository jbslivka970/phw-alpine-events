#!/usr/bin/env node

/**
 * Removes lingering E2E contract/probe events from the Events API.
 *
 * Safe-by-default behavior:
 * - Dry-run unless --apply is provided.
 * - Optional age threshold via --older-than-hours=<n>.
 *
 * Auth:
 * - ADMIN_BEARER_TOKEN env var (preferred)
 *
 * Optional env:
 * - BACKEND_BASE_URL (default: https://phwalpineeventsjb873a.azurewebsites.net)
 * - E2E_CLEANUP_TENANT_ID (adds X-Tenant-Id header)
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'https://phwalpineeventsjb873a.azurewebsites.net').replace(/\/$/, '');
const token = (process.env.ADMIN_BEARER_TOKEN || '').trim();
const tenantId = (process.env.E2E_CLEANUP_TENANT_ID || '').trim();

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const olderThanArg = args.find((arg) => arg.startsWith('--older-than-hours='));
const olderThanHours = olderThanArg ? Number.parseFloat(olderThanArg.split('=')[1] || '') : 0;

if (!token) {
  console.error('Missing ADMIN_BEARER_TOKEN environment variable.');
  process.exit(1);
}

if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
  console.error('Invalid --older-than-hours value. Use a number >= 0.');
  process.exit(1);
}

const nowMs = Date.now();
const olderThanMs = olderThanHours * 60 * 60 * 1000;
const titleMatchers = [
  /^Playwright Contract Event/i,
  /^Contract Probe/i,
];

function buildHeaders() {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (tenantId) {
    headers['X-Tenant-Id'] = tenantId;
  }

  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    ...options,
    headers: {
      ...buildHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { ok: response.ok, status: response.status, body };
}

function isContractEvent(event) {
  const title = String(event?.title || '').trim();
  if (!title) {
    return false;
  }

  const matchesTitle = titleMatchers.some((matcher) => matcher.test(title));
  const description = String(event?.description || '').toLowerCase();
  const hasContractMarker = description.includes('role matrix contract') || description.includes('contract probe');

  return matchesTitle || hasContractMarker;
}

function isOlderThanThreshold(event) {
  if (olderThanMs <= 0) {
    return true;
  }

  const eventDateRaw = event?.event_date || event?.created_at || null;
  if (!eventDateRaw) {
    return true;
  }

  const eventMs = Date.parse(String(eventDateRaw));
  if (!Number.isFinite(eventMs)) {
    return true;
  }

  return nowMs - eventMs >= olderThanMs;
}

async function tryCancelEvent(eventId) {
  return requestWithRetry(`/api/v1/events/${eventId}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'cancelled' }),
  });
}

async function tryDeleteEvent(eventId) {
  return requestWithRetry(`/api/v1/events/${eventId}`, {
    method: 'DELETE',
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestWithRetry(path, options, maxRetries = 4) {
  let attempt = 0;
  let response = await api(path, options);

  while (response.status === 429 && attempt < maxRetries) {
    const backoffMs = 500 * (2 ** attempt);
    await delay(backoffMs);
    attempt += 1;
    response = await api(path, options);
  }

  return response;
}

async function main() {
  const listRes = await api('/api/v1/events?limit=500&sort=desc');
  if (!listRes.ok || !Array.isArray(listRes.body)) {
    console.error(`Failed to list events (${listRes.status}).`);
    console.error(typeof listRes.body === 'string' ? listRes.body : JSON.stringify(listRes.body));
    process.exit(1);
  }

  const candidates = listRes.body
    .filter((event) => isContractEvent(event))
    .filter((event) => isOlderThanThreshold(event));

  const summary = {
    backend_base_url: backendBaseUrl,
    apply: applyChanges,
    older_than_hours: olderThanHours,
    tenant_id: tenantId || null,
    scanned: listRes.body.length,
    matched: candidates.length,
    cancelled: 0,
    deleted: 0,
    failed: 0,
    failures: [],
    sample: candidates.slice(0, 25).map((event) => ({
      event_id: event.event_id,
      title: event.title,
      status: event.status,
      event_date: event.event_date ?? null,
    })),
  };

  if (!applyChanges) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for (const event of candidates) {
    const eventId = event?.event_id;
    if (typeof eventId !== 'string' || eventId.trim().length === 0) {
      summary.failed += 1;
      summary.failures.push({ event_id: null, reason: 'missing_event_id' });
      continue;
    }

    const cancelRes = await tryCancelEvent(eventId);
    if (cancelRes.ok || cancelRes.status === 409 || cancelRes.status === 404) {
      if (cancelRes.ok) {
        summary.cancelled += 1;
      }
    }

    const deleteRes = await tryDeleteEvent(eventId);
    if (deleteRes.ok || deleteRes.status === 204 || deleteRes.status === 404) {
      if (deleteRes.ok || deleteRes.status === 204) {
        summary.deleted += 1;
      }
      continue;
    }

    summary.failed += 1;
    summary.failures.push({
      event_id: eventId,
      status: deleteRes.status,
      reason: typeof deleteRes.body === 'string' ? deleteRes.body : JSON.stringify(deleteRes.body),
    });
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
