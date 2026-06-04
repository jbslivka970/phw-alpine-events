#!/usr/bin/env node

/**
 * Post-deploy tenant event isolation verifier.
 *
 * Purpose:
 * - Detect cross-tenant leakage by checking whether the same event_id appears
 *   in both tenant-scoped event list responses.
 *
 * Required env:
 * - ADMIN_BEARER_TOKEN
 *
 * Optional env:
 * - BACKEND_BASE_URL (default: https://phwalpineeventsjb873a.azurewebsites.net)
 *
 * Optional args:
 * - --tenant-a=<tenant-id>
 * - --tenant-b=<tenant-id>
 * - --limit=<n>                   (default: 500)
 * - --needle=<text>               (only evaluate events where title/location/description includes text)
 * - --allow-overlap               (do not fail process when overlap is found)
 *
 * Exit codes:
 * - 0: no overlap (or overlap allowed)
 * - 1: validation/runtime failure
 * - 2: overlap detected (default behavior)
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'https://phwalpineeventsjb873a.azurewebsites.net').replace(/\/$/, '');
const token = (process.env.ADMIN_BEARER_TOKEN || '').trim();

const args = process.argv.slice(2);
const tenantAArg = readArgValue(args, '--tenant-a');
const tenantBArg = readArgValue(args, '--tenant-b');
const needleArg = readArgValue(args, '--needle');
const limitArg = readArgValue(args, '--limit');
const allowOverlap = args.includes('--allow-overlap');

if (!token) {
  console.error('Missing ADMIN_BEARER_TOKEN environment variable.');
  process.exit(1);
}

const limit = normalizeLimit(limitArg);
if (!Number.isFinite(limit) || limit <= 0) {
  console.error('Invalid --limit value. Use a positive integer.');
  process.exit(1);
}

function readArgValue(argv, key) {
  const match = argv.find((arg) => arg.startsWith(`${key}=`));
  if (!match) {
    return null;
  }
  const value = match.slice(key.length + 1).trim();
  return value.length > 0 ? value : null;
}

function normalizeLimit(raw) {
  if (!raw) {
    return 500;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return Number.NaN;
  }
  return Math.max(1, Math.min(2000, parsed));
}

function buildHeaders(tenantId) {
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
  const response = await fetch(`${backendBaseUrl}${path}`, options);
  const text = await response.text();

  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
    headers: response.headers,
  };
}

function normalizeTenantId(raw) {
  if (!raw) {
    return null;
  }
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function includeByNeedle(event, needle) {
  if (!needle) {
    return true;
  }

  const haystack = [event?.title, event?.location, event?.description]
    .map((part) => normalizeText(part))
    .join(' ');

  return haystack.includes(needle);
}

function chooseTenantPair(tenants, explicitA, explicitB) {
  const byId = new Map(tenants.map((tenant) => [normalizeTenantId(tenant.tenant_id), tenant]));

  const normalizedA = normalizeTenantId(explicitA);
  const normalizedB = normalizeTenantId(explicitB);

  if (normalizedA && normalizedB) {
    const a = byId.get(normalizedA);
    const b = byId.get(normalizedB);
    if (!a || !b) {
      throw new Error('Explicit tenant IDs were provided but not found in /api/v1/me/tenants response.');
    }
    return [a, b];
  }

  const demoTenant = tenants.find((tenant) => tenant.slug === 'demo' || tenant.is_demo === true) || null;
  const coloradoTenant = tenants.find((tenant) => tenant.slug === 'colorado-alpine') || null;

  if (demoTenant && coloradoTenant) {
    return [coloradoTenant, demoTenant];
  }

  if (tenants.length >= 2) {
    return [tenants[0], tenants[1]];
  }

  throw new Error('Could not resolve two tenant contexts for comparison.');
}

function mapEventsById(events, needle) {
  const byId = new Map();

  for (const event of events) {
    const eventId = String(event?.event_id || '').trim().toLowerCase();
    if (!eventId) {
      continue;
    }
    if (!includeByNeedle(event, needle)) {
      continue;
    }

    byId.set(eventId, {
      event_id: event.event_id,
      title: event.title || null,
      location: event.location || null,
      status: event.status || null,
      event_date: event.event_date || null,
    });
  }

  return byId;
}

async function fetchEventsForTenant(tenantId, limitValue) {
  const params = new URLSearchParams();
  params.set('limit', String(limitValue));
  params.set('sort', 'desc');

  const result = await api(`/api/v1/events?${params.toString()}`, {
    method: 'GET',
    headers: buildHeaders(tenantId),
  });

  if (!result.ok || !Array.isArray(result.body)) {
    const bodyText = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    throw new Error(`Failed to list events for tenant ${tenantId} (${result.status}): ${bodyText}`);
  }

  return {
    events: result.body,
    activeTenantHeader: result.headers.get('x-active-tenant-id'),
  };
}

async function main() {
  const meTenants = await api('/api/v1/me/tenants', {
    method: 'GET',
    headers: buildHeaders(null),
  });

  if (!meTenants.ok || !Array.isArray(meTenants.body)) {
    const bodyText = typeof meTenants.body === 'string' ? meTenants.body : JSON.stringify(meTenants.body);
    throw new Error(`Failed to fetch tenant contexts (${meTenants.status}): ${bodyText}`);
  }

  const [tenantA, tenantB] = chooseTenantPair(meTenants.body, tenantAArg, tenantBArg);

  const needle = needleArg ? needleArg.trim().toLowerCase() : null;

  const [resultA, resultB] = await Promise.all([
    fetchEventsForTenant(tenantA.tenant_id, limit),
    fetchEventsForTenant(tenantB.tenant_id, limit),
  ]);

  const aById = mapEventsById(resultA.events, needle);
  const bById = mapEventsById(resultB.events, needle);

  const overlap = [];
  for (const [eventId, left] of aById.entries()) {
    const right = bById.get(eventId);
    if (!right) {
      continue;
    }
    overlap.push({
      event_id: eventId,
      tenant_a_title: left.title,
      tenant_a_location: left.location,
      tenant_b_title: right.title,
      tenant_b_location: right.location,
      status_a: left.status,
      status_b: right.status,
    });
  }

  const output = {
    backend_base_url: backendBaseUrl,
    limit,
    needle: needle ?? null,
    tenant_a: {
      tenant_id: tenantA.tenant_id,
      slug: tenantA.slug,
      display_name: tenantA.display_name,
      role: tenantA.role,
      active_tenant_header: resultA.activeTenantHeader,
      fetched_count: resultA.events.length,
      evaluated_count: aById.size,
    },
    tenant_b: {
      tenant_id: tenantB.tenant_id,
      slug: tenantB.slug,
      display_name: tenantB.display_name,
      role: tenantB.role,
      active_tenant_header: resultB.activeTenantHeader,
      fetched_count: resultB.events.length,
      evaluated_count: bById.size,
    },
    overlap_count: overlap.length,
    overlap_sample: overlap.slice(0, 25),
  };

  console.log(JSON.stringify(output, null, 2));

  if (overlap.length > 0 && !allowOverlap) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
