#!/usr/bin/env node

/**
 * Create a one-off test member + event and publish to that recipient only.
 *
 * Required env:
 * - ADMIN_BEARER_TOKEN: Admin JWT for backend API
 *
 * Optional env:
 * - BACKEND_BASE_URL (default: https://phwalpineeventsjb873a.azurewebsites.net)
 * - TEST_EMAIL (default: sarnitro@gmail.com)
 * - TEST_PHONE (default: 970-418-0120)
 * - TEST_FIRST_NAME (default: Sar)
 * - TEST_LAST_NAME (default: Nitro)
 */

const backendBaseUrl = (process.env.BACKEND_BASE_URL || 'https://phwalpineeventsjb873a.azurewebsites.net').replace(/\/$/, '');
const token = (process.env.ADMIN_BEARER_TOKEN || '').trim();

const testEmail = (process.env.TEST_EMAIL || 'sarnitro@gmail.com').trim().toLowerCase();
const testPhone = toE164(process.env.TEST_PHONE || '970-418-0120');
const testFirstName = (process.env.TEST_FIRST_NAME || 'Sar').trim();
const testLastName = (process.env.TEST_LAST_NAME || 'Nitro').trim();

if (!token) {
  console.error('Missing ADMIN_BEARER_TOKEN.');
  process.exit(1);
}

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (String(raw || '').startsWith('+') && digits.length >= 11) {
    return `+${digits}`;
  }
  throw new Error(`Cannot normalize phone number to E.164: ${raw}`);
}

async function api(path, options = {}) {
  const res = await fetch(`${backendBaseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${res.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body;
}

async function ensureMember() {
  const list = await api(`/api/v1/members?search=${encodeURIComponent(testEmail)}&page=1&pageSize=200`);
  const rows = Array.isArray(list?.data) ? list.data : [];
  const existing = rows.find((m) => String(m.email || '').trim().toLowerCase() === testEmail);

  const payload = {
    first_name: testFirstName,
    last_name: testLastName,
    email: testEmail,
    mobile_phone: testPhone,
    sms_opt_in: true,
    email_opt_out: false,
    is_active: true,
  };

  if (existing) {
    const updated = await api(`/api/v1/members/${existing.member_id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return { member: updated, created: false };
  }

  const created = await api('/api/v1/members', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { member: created, created: true };
}

async function ensureGroup(memberId) {
  const groupName = 'UAT RECIPIENT - SARNITRO';
  const groups = await api('/api/v1/groups');
  const existing = Array.isArray(groups)
    ? groups.find((g) => String(g.group_name || '').trim().toLowerCase() === groupName.toLowerCase())
    : null;

  const group = existing || (await api('/api/v1/groups', {
    method: 'POST',
    body: JSON.stringify({
      group_name: groupName,
      description: 'One-off isolated recipient group for UAT notification tests.',
    }),
  }));

  const memberIds = await api(`/api/v1/groups/${group.group_id}/members`);
  const hasMember = Array.isArray(memberIds) && memberIds.includes(memberId);
  if (!hasMember) {
    await api(`/api/v1/groups/${group.group_id}/members/${memberId}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  return group;
}

async function createAndPublishEvent(groupId) {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(17, 0, 0, 0);

  const end = new Date(start);
  end.setHours(end.getHours() + 2);

  const title = `UAT Test Event - ${new Date().toISOString().slice(0, 16)}`;

  const event = await api('/api/v1/events', {
    method: 'POST',
    body: JSON.stringify({
      title,
      description: 'Automated UAT test event targeting a single recipient group.',
      location: 'PHW Test Location',
      event_date: start.toISOString(),
      end_date: end.toISOString(),
      participant_capacity: 1,
      notification_targets: [{ group_id: groupId }],
    }),
  });

  const published = await api(`/api/v1/events/${event.event_id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'published' }),
  });

  return { draft: event, published };
}

async function main() {
  const { member, created } = await ensureMember();
  const group = await ensureGroup(member.member_id);
  const { draft, published } = await createAndPublishEvent(group.group_id);

  console.log(JSON.stringify({
    backend_base_url: backendBaseUrl,
    member_action: created ? 'created' : 'updated',
    member_id: member.member_id,
    recipient_email: member.email,
    recipient_phone: member.mobile_phone,
    group_id: group.group_id,
    group_name: group.group_name,
    event_id: draft.event_id,
    event_title: draft.title,
    event_status: published.status,
    event_date: draft.event_date,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
