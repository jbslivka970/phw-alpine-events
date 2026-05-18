import { getPool, sql } from '../db';
import { notificationService } from './notifications';
import { getEventEmailWorkflowSettings } from './eventEmailWorkflowService';
import { loadEventSummaryEmailConfig, normalizeEmail, normalizeEmailList } from './eventSummaryEmailConfig';

interface EventSummaryReportData {
  event: {
    event_id: string;
    title: string;
    description: string | null;
    location: string | null;
    event_date: Date | string;
    end_date: Date | string | null;
    status: string;
    event_lead_name: string | null;
    event_lead_email: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  };
  assignments: Array<{
    assignment_id: string;
    member_id: string;
    first_name: string;
    last_name: string;
    email: string;
    mobile_phone: string | null;
    role: string;
    assigned_at: Date | string;
    attended: boolean | null;
    attendance_notes: string | null;
  }>;
  responses: Array<{
    response_id: string;
    member_id: string;
    first_name: string;
    last_name: string;
    email: string;
    mobile_phone: string | null;
    response: string;
    response_role: string | null;
    response_channel: string | null;
    responded_at: Date | string;
    notes: string | null;
  }>;
}

export async function loadEventSummaryReportData(eventId: string): Promise<EventSummaryReportData | null> {
  const pool = await getPool();

  const eventResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<EventSummaryReportData['event']>(
      `SELECT event_id,
              title,
              description,
              location,
              event_date,
              end_date,
              status,
              CASE WHEN COL_LENGTH('dbo.event', 'event_lead_name') IS NULL THEN CAST(NULL AS NVARCHAR(200)) ELSE event_lead_name END AS event_lead_name,
              CASE WHEN COL_LENGTH('dbo.event', 'event_lead_email') IS NULL THEN CAST(NULL AS NVARCHAR(255)) ELSE event_lead_email END AS event_lead_email,
              created_at,
              updated_at
       FROM dbo.event
       WHERE event_id = @event_id`
    );

  const event = eventResult.recordset[0];
  if (!event) {
    return null;
  }

  const assignmentsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<EventSummaryReportData['assignments'][number]>(
      `SELECT ea.assignment_id,
              ea.member_id,
              m.first_name,
              m.last_name,
              m.email,
              m.mobile_phone,
              ea.role,
              ea.assigned_at,
              ea.attended,
              ea.attendance_notes
       FROM dbo.event_assignment ea
       INNER JOIN dbo.member m ON m.member_id = ea.member_id
       WHERE ea.event_id = @event_id
       ORDER BY ea.assigned_at ASC`
    );

  const responsesResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<EventSummaryReportData['responses'][number]>(
      `SELECT er.response_id,
              er.member_id,
              m.first_name,
              m.last_name,
              m.email,
              m.mobile_phone,
              er.response,
              er.response_role,
              er.response_channel,
              er.responded_at,
              er.notes
       FROM dbo.event_response er
       INNER JOIN dbo.member m ON m.member_id = er.member_id
       WHERE er.event_id = @event_id
       ORDER BY er.responded_at ASC`
    );

  return {
    event,
    assignments: assignmentsResult.recordset,
    responses: responsesResult.recordset,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatContact(email: string | null, mobilePhone: string | null): string {
  return `email: ${email?.trim() || 'n/a'} | phone: ${mobilePhone?.trim() || 'n/a'}`;
}

function formatReportTimestamp(value: Date | string | null): string {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toISOString();
}

function formatMountainDateTime(value: Date | string | null): string {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(parsed);

  const lookup = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${lookup('year')}-${lookup('month')}-${lookup('day')} ${lookup('hour')}:${lookup('minute')} MT`;
}

function toDisplayName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return 'Team';
  }

  return normalized
    .split(' ')
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase())
    .join(' ');
}

async function lookupMemberDisplayNameByEmail(email: string): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('email', sql.NVarChar, normalized)
    .query<{ first_name: string | null; last_name: string | null }>(
      `SELECT TOP (1) first_name, last_name
       FROM dbo.member
       WHERE LOWER(LTRIM(RTRIM(email))) = @email`
    );

  const row = result.recordset[0];
  if (!row) {
    return null;
  }

  const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  return fullName || null;
}

async function resolvePreparedByName(actorName: string | undefined, actor: string): Promise<string> {
  const preferred = actorName?.trim();
  if (preferred) {
    return preferred;
  }

  if (actor.includes('@')) {
    const fromMember = await lookupMemberDisplayNameByEmail(actor);
    if (fromMember) {
      return fromMember;
    }
    return toDisplayName(actor.split('@')[0] ?? actor);
  }

  return toDisplayName(actor);
}

function resolveLeadGreetingName(report: EventSummaryReportData): string {
  const directName = report.event.event_lead_name?.trim();
  if (directName) {
    return directName.split(/\s+/)[0] ?? directName;
  }

  if (report.event.event_lead_email && report.event.event_lead_email.includes('@')) {
    return toDisplayName(report.event.event_lead_email.split('@')[0] ?? 'there');
  }

  return 'there';
}

function padColumn(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, Math.max(width - 1, 1)) + (width > 1 ? '…' : '');
  }
  return value.padEnd(width, ' ');
}

function buildLeadPrepRosterLines(report: EventSummaryReportData): string[] {
  if (report.assignments.length === 0) {
    return ['none'];
  }

  const header = `${padColumn('Name', 24)} ${padColumn('Role', 13)} ${padColumn('Email', 34)} Phone`;
  const divider = '-'.repeat(header.length);
  const rows = report.assignments.map((row) => {
    const name = `${row.first_name} ${row.last_name}`.trim();
    return `${padColumn(name, 24)} ${padColumn(row.role, 13)} ${padColumn(row.email, 34)} ${row.mobile_phone?.trim() || 'n/a'}`;
  });

  return [header, divider, ...rows];
}

function buildWaitlistLines(report: EventSummaryReportData): string[] {
  const waitlistRows = report.responses.filter((row) => row.response === 'waitlist');
  if (waitlistRows.length === 0) {
    return ['none'];
  }

  const header = `${padColumn('Name', 24)} ${padColumn('Role', 13)} ${padColumn('Email', 34)} Phone`;
  const divider = '-'.repeat(header.length);
  const rows = waitlistRows.map((row) => {
    const name = `${row.first_name} ${row.last_name}`.trim();
    const role = row.response_role ?? 'n/a';
    return `${padColumn(name, 24)} ${padColumn(role, 13)} ${padColumn(row.email, 34)} ${row.mobile_phone?.trim() || 'n/a'}`;
  });

  return [header, divider, ...rows];
}

function buildHtmlTable(headers: string[], rows: string[][]): string {
  const headerHtml = headers
    .map((header) => `<th style="text-align:left;padding:8px;border-bottom:1px solid #d9d9d9;">${escapeHtml(header)}</th>`)
    .join('');
  const rowHtml = rows
    .map((row) => `<tr>${row.map((value) => `<td style="padding:8px;border-bottom:1px solid #efefef;vertical-align:top;">${escapeHtml(value)}</td>`).join('')}</tr>`)
    .join('');

  return `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:14px;line-height:1.4;">${headerHtml ? `<thead><tr>${headerHtml}</tr></thead>` : ''}<tbody>${rowHtml}</tbody></table>`;
}

function formatMountainDateLong(value: Date | string | null): string {
  if (!value) {
    return 'Date TBD';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Date TBD';
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function formatMountainTime(value: Date | string | null): string {
  if (!value) {
    return 'TBD';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'TBD';
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function formatPhoneForDisplay(phone: string | null): string {
  const trimmed = phone?.trim();
  if (!trimmed) {
    return 'n/a';
  }

  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    const core = digits.slice(1);
    return `(${core.slice(0, 3)}) ${core.slice(3, 6)}-${core.slice(6)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return trimmed;
}

function formatPhoneForHref(phone: string | null): string {
  const trimmed = phone?.trim();
  if (!trimmed) {
    return '';
  }

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) {
    return '';
  }
  return hasPlus ? `+${digits}` : digits;
}

function buildLocationMapHref(location: string | null): string | null {
  const trimmed = location?.trim();
  if (!trimmed) {
    return null;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}

function statusChipColor(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'published') {
    return '#2d5a3d';
  }
  if (normalized === 'completed') {
    return '#1f342f';
  }
  if (normalized === 'cancelled') {
    return '#7f1d1d';
  }
  return '#6b7280';
}

function buildRosterPersonRowHtml(args: {
  name: string;
  role: string;
  email: string;
  phone: string | null;
  waitlist?: boolean;
}): string {
  const normalizedRole = args.role.toUpperCase() === 'PARTICIPANT' ? 'PARTICIPANT' : 'MENTOR';
  const badgeBg = normalizedRole === 'MENTOR' ? '#1f342f' : '#2d5a3d';
  const badgeText = args.waitlist ? `${normalizedRole} WAITLIST` : normalizedRole;
  const emailHref = `mailto:${encodeURIComponent(args.email)}`;
  const phoneHref = formatPhoneForHref(args.phone);
  const phoneDisplay = formatPhoneForDisplay(args.phone);

  return [
    '<tr>',
    '  <td style="padding:14px 0;border-bottom:1px solid #e5e0d5;">',
    '    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    '      <tr>',
    `        <td style="padding-bottom:4px;"><span style="font-weight:600;color:#2c2c2c;font-size:14px;">${escapeHtml(args.name)}</span><span style="display:inline-block;background-color:${args.waitlist ? '#6b6b6b' : badgeBg};color:#ffffff;font-size:10px;letter-spacing:1px;padding:2px 8px;border-radius:2px;margin-left:8px;vertical-align:middle;">${escapeHtml(badgeText)}</span></td>`,
    '      </tr>',
    '      <tr>',
    '        <td style="color:#6b6b6b;font-size:13px;">',
    `          <a href="${emailHref}" style="color:#c8762a;text-decoration:none;">${escapeHtml(args.email)}</a>`,
    `          ${phoneHref ? '&nbsp;&middot;&nbsp;' : ''}`,
    phoneHref
      ? `          <a href="tel:${escapeHtml(phoneHref)}" style="color:#6b6b6b;text-decoration:none;">${escapeHtml(phoneDisplay)}</a>`
      : `          <span style="color:#6b6b6b;">${escapeHtml(phoneDisplay)}</span>`,
    '        </td>',
    '      </tr>',
    '    </table>',
    '  </td>',
    '</tr>',
  ].join('');
}

function buildLeadPrepSummaryText(report: EventSummaryReportData): string {
  const assignedMentorCount = report.assignments.filter((row) => row.role.toUpperCase() === 'MENTOR').length;
  const assignedParticipantCount = report.assignments.filter((row) => row.role.toUpperCase() === 'PARTICIPANT').length;
  const waitlistCount = report.responses.filter((row) => row.response === 'waitlist').length;

  return [
    `Event: ${report.event.title}`,
    `Status: ${report.event.status}`,
    `Start (MT): ${formatMountainDateTime(report.event.event_date)}`,
    `End (MT): ${formatMountainDateTime(report.event.end_date)}`,
    `Location: ${report.event.location ?? 'n/a'}`,
    '',
    'RSVP Snapshot',
    `- Assigned Mentors: ${assignedMentorCount}`,
    `- Assigned Participants: ${assignedParticipantCount}`,
    `- RSVP Waitlist: ${waitlistCount}`,
    '',
    'Assigned Roster',
    ...buildLeadPrepRosterLines(report),
    '',
    'Waitlist RSVPs',
    ...buildWaitlistLines(report),
    '',
    `Generated at (MT): ${formatMountainDateTime(new Date())}`,
  ].join('\n');
}

function buildPostEventParticipationSummaryText(report: EventSummaryReportData): string {
  const attended = report.assignments.filter((row) => row.attended === true);
  const notAttended = report.assignments.filter((row) => row.attended === false);
  const unmarked = report.assignments.filter((row) => row.attended === null);

  return [
    'Hello,',
    '',
    'This post-event summary captures who was assigned, who participated, and who did not attend so you can close the loop on the event.',
    '',
    `Event: ${report.event.title}`,
    `Status: ${report.event.status}`,
    `Start: ${formatReportTimestamp(report.event.event_date)}`,
    `End: ${formatReportTimestamp(report.event.end_date) || 'n/a'}`,
    `Location: ${report.event.location ?? 'n/a'}`,
    '',
    'Attendance Snapshot',
    `- Participated: ${attended.length}`,
    `- No-show / not attended: ${notAttended.length}`,
    `- Attendance not recorded: ${unmarked.length}`,
    '',
    'Participated',
    ...(attended.length === 0 ? ['- none'] : attended.map((row) => `- ${row.first_name} ${row.last_name} (${row.role}) | ${formatContact(row.email, row.mobile_phone)}`)),
    '',
    'No-show / Not Attended',
    ...(notAttended.length === 0 ? ['- none'] : notAttended.map((row) => `- ${row.first_name} ${row.last_name} (${row.role}) | ${formatContact(row.email, row.mobile_phone)}`)),
    '',
    'Attendance Not Recorded',
    ...(unmarked.length === 0 ? ['- none'] : unmarked.map((row) => `- ${row.first_name} ${row.last_name} (${row.role}) | ${formatContact(row.email, row.mobile_phone)}`)),
    '',
    `Generated at: ${new Date().toISOString()}`,
  ].join('\n');
}

async function buildCcRecipients(primaryRecipient: string): Promise<string[]> {
  const config = await loadEventSummaryEmailConfig();
  return normalizeEmailList([
    config.programLeadEmail,
    ...config.assistantProgramLeadEmails,
  ]).filter((value) => value !== primaryRecipient);
}

export async function sendPreEventLeadSummaryEmail(args: {
  eventId: string;
  actor: string;
  actorName?: string;
  operationReason: string;
}): Promise<{ to: string; cc: string[] }> {
  const report = await loadEventSummaryReportData(args.eventId);
  if (!report) {
    throw new Error('Event not found');
  }

  const leadEmail = normalizeEmail(report.event.event_lead_email);
  if (!leadEmail) {
    throw new Error('event_lead_email is required before sending the pre-event lead summary.');
  }

  const ccRecipients = await buildCcRecipients(leadEmail);
  const textBody = buildLeadPrepSummaryText(report);
  const subject = `Lead Prep Summary: ${report.event.title}`;
  const preparedByName = await resolvePreparedByName(args.actorName, args.actor);
  const leadGreetingName = resolveLeadGreetingName(report);
  const assignedMentorCount = report.assignments.filter((row) => row.role.toUpperCase() === 'MENTOR').length;
  const assignedParticipantCount = report.assignments.filter((row) => row.role.toUpperCase() === 'PARTICIPANT').length;
  const waitlistRows = report.responses.filter((row) => row.response === 'waitlist');
  const waitlistCount = waitlistRows.length;
  const assignedRows = report.assignments.map((row) => ({
    name: `${row.first_name} ${row.last_name}`.trim(),
    role: row.role,
    email: row.email,
    phone: row.mobile_phone,
  }));
  const waitlistTableRows = waitlistRows.map((row) => ({
    name: `${row.first_name} ${row.last_name}`.trim(),
    role: row.response_role ?? 'MENTOR',
    email: row.email,
    phone: row.mobile_phone,
  }));
  const mapHref = buildLocationMapHref(report.event.location);
  const assignedEmailList = Array.from(new Set(assignedRows.map((row) => row.email.trim()).filter((value) => Boolean(value))));
  const bccHref = assignedEmailList.length > 0
    ? `mailto:?bcc=${encodeURIComponent(assignedEmailList.join(','))}&subject=${encodeURIComponent(`${report.event.title} - ${formatMountainDateLong(report.event.event_date)}`)}`
    : null;
  const heroDateLine = `${formatMountainDateLong(report.event.event_date)}&nbsp;&middot;&nbsp;${escapeHtml(formatMountainTime(report.event.event_date))} - ${escapeHtml(formatMountainTime(report.event.end_date))} MT`;
  const preheader = `${report.event.title} - ${formatMountainDateLong(report.event.event_date)} - roster and contacts for event coordination.`;
  const assignedRosterHtml = assignedRows.length > 0
    ? assignedRows.map((row) => buildRosterPersonRowHtml({
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
    })).join('')
    : '<tr><td style="padding:10px 0;color:#6b6b6b;">No assigned roster yet.</td></tr>';
  const waitlistRosterHtml = waitlistTableRows.length > 0
    ? waitlistTableRows.map((row) => buildRosterPersonRowHtml({
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
      waitlist: true,
    })).join('')
    : '<tr><td style="padding:10px 0;color:#6b6b6b;">No waitlist members.</td></tr>';
  const htmlBody = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>Event Coordination - ${escapeHtml(report.event.title)}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">',
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f1ea;">${escapeHtml(preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f1ea;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background-color:#ffffff;border:1px solid #e5e0d5;border-radius:4px;overflow:hidden;">',
    '<tr><td style="background-color:#1f342f;padding:32px 32px 28px 32px;border-bottom:3px solid #c8762a;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td style="padding-bottom:10px;"><span style="display:inline-block;width:20px;height:1px;background-color:#c8762a;vertical-align:middle;margin-right:10px;"></span><span style="color:#c8762a;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:600;">Colorado Alpine Program</span></td></tr>',
    `<tr><td style="color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:normal;line-height:1.2;">${escapeHtml(report.event.title)}</td></tr>`,
    `<tr><td style="color:#b8c9c1;font-size:14px;padding-top:8px;">${heroDateLine}</td></tr>`,
    '<tr><td style="color:#8fa39a;font-family:Georgia,\'Times New Roman\',serif;font-style:italic;font-size:13px;padding-top:14px;">The river is always there, waiting.</td></tr>',
    '</table>',
    '</td></tr>',
    '<tr><td style="padding:32px 32px 8px 32px;color:#2c2c2c;font-size:15px;line-height:1.65;">',
    `${escapeHtml(leadGreetingName)} -<br><br>`,
    '<strong style="color:#1f342f;">Thanks for taking the lead on this one.</strong> Below is everything you need to coordinate: assigned roster, role assignments, contact info, and waitlist visibility so prep and follow-up are a quick scan away.',
    '<br><br>',
    'The Program Lead and Assistant Program Leads are CC&#39;d here too. Reach out anytime if you need support.',
    `<br><br><span style="color:#6b6b6b;font-size:13px;font-style:italic;">Summary prepared by ${escapeHtml(preparedByName)}</span>`,
    '</td></tr>',
    '<tr><td style="padding:0 32px;"><div style="height:1px;background-color:#e5e0d5;margin:20px 0;"></div></td></tr>',
    '<tr><td style="padding:0 32px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf8f3;border-left:3px solid #c8762a;">',
    '<tr><td style="padding:18px 22px;">',
    '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#1f342f;padding-bottom:12px;">Event Details</div>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;color:#2c2c2c;">',
    `<tr><td width="90" style="padding:4px 0;color:#6b6b6b;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;">Status</td><td style="padding:4px 0;"><span style="display:inline-block;background-color:${statusChipColor(report.event.status)};color:#ffffff;font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:3px 10px;border-radius:2px;">${escapeHtml(report.event.status)}</span></td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b6b6b;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;">Start</td><td style="padding:4px 0;">${escapeHtml(formatMountainDateTime(report.event.event_date))}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b6b6b;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;">End</td><td style="padding:4px 0;">${escapeHtml(formatMountainDateTime(report.event.end_date))}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#6b6b6b;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;">Location</td><td style="padding:4px 0;">${mapHref ? `<a href="${escapeHtml(mapHref)}" style="color:#1f342f;text-decoration:underline;">${escapeHtml(report.event.location ?? 'n/a')}</a>` : escapeHtml(report.event.location ?? 'n/a')}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</td></tr>',
    '<tr><td style="padding:28px 32px 8px 32px;">',
    '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#1f342f;padding-bottom:12px;">RSVP Snapshot</div>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td width="33%" style="background-color:#1f342f;color:#ffffff;padding:14px 8px;text-align:center;border-right:1px solid #ffffff;"><div style="font-family:Georgia,serif;font-size:28px;line-height:1;">${assignedMentorCount}</div><div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;padding-top:4px;color:#e0a87a;">Assigned Mentors</div></td>`,
    `<td width="33%" style="background-color:#2d5a3d;color:#ffffff;padding:14px 8px;text-align:center;border-right:1px solid #ffffff;"><div style="font-family:Georgia,serif;font-size:28px;line-height:1;">${assignedParticipantCount}</div><div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;padding-top:4px;">Assigned Participants</div></td>`,
    `<td width="34%" style="background-color:#6b6b6b;color:#ffffff;padding:14px 8px;text-align:center;"><div style="font-family:Georgia,serif;font-size:28px;line-height:1;">${waitlistCount}</div><div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;padding-top:4px;">Waitlist</div></td>`,
    '</tr></table>',
    '</td></tr>',
    bccHref
      ? '<tr><td style="padding:24px 32px 8px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#1f342f;border-radius:3px;"><tr><td style="padding:18px 22px;">'
        + '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c8762a;padding-bottom:10px;">Email the Roster</div>'
        + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#c8762a;border-radius:3px;">'
        + `<a href="${escapeHtml(bccHref)}" style="display:inline-block;padding:10px 22px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.5px;">Open BCC Draft to All Assigned</a>`
        + '</td></tr></table>'
        + `<div style="color:#b8c9c1;font-size:12px;line-height:1.6;padding-top:14px;"><strong style="color:#ffffff;">Copy all emails:</strong><br><span style="font-family:'Courier New',monospace;font-size:12px;color:#ffffff;background-color:#152724;padding:8px 10px;display:inline-block;margin-top:6px;border-radius:2px;word-break:break-all;">${escapeHtml(assignedEmailList.join(', '))}</span></div>`
        + '</td></tr></table></td></tr>'
      : '',
    '<tr><td style="padding:28px 32px 12px 32px;"><div style="font-family:Georgia,\'Times New Roman\',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#1f342f;">Assigned Roster</div></td></tr>',
    '<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:13px;">',
    assignedRosterHtml,
    '</table></td></tr>',
    '<tr><td style="padding:28px 32px 12px 32px;"><div style="font-family:Georgia,\'Times New Roman\',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6b6b;">Waitlist</div></td></tr>',
    '<tr><td style="padding:0 32px 8px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:13px;background-color:#faf8f3;">',
    waitlistRosterHtml,
    '</table></td></tr>',
    '<tr><td style="padding:32px;background-color:#faf8f3;border-top:1px solid #e5e0d5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="color:#6b6b6b;font-size:12px;line-height:1.6;text-align:center;">',
    '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:13px;color:#1f342f;padding-bottom:4px;">Project Healing Waters Fly Fishing</div>',
    '<div>Colorado Alpine Program</div>',
    `<div style="padding-top:8px;color:#a8a8a8;font-size:11px;letter-spacing:1px;">Generated ${escapeHtml(formatMountainDateTime(new Date()))}</div>`,
    '</td></tr></table></td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  await notificationService.sendEmail({
    to: leadEmail,
    cc: ccRecipients,
    subject,
    htmlBody,
    textBody,
    eventId: report.event.event_id,
    operationType: 'event_lead_prep_email',
    operationReason: args.operationReason,
  });

  return { to: leadEmail, cc: ccRecipients };
}

export async function sendPostEventParticipationSummaryEmail(args: {
  eventId: string;
  actor: string;
  operationReason: string;
}): Promise<{ to: string; cc: string[]; fallbackUsed: 'scheduler' | 'creator' | 'actor' }> {
  const report = await loadEventSummaryReportData(args.eventId);
  if (!report) {
    throw new Error('Event not found');
  }

  if (report.event.status !== 'completed') {
    throw new Error('Event must be completed before sending the participation summary.');
  }

  const settings = await getEventEmailWorkflowSettings(report.event.event_id);
  const actorEmail = normalizeEmail(args.actor);
  const to = settings.schedulerEmail ?? settings.creatorEmail ?? actorEmail;
  const fallbackUsed = settings.schedulerEmail ? 'scheduler' : settings.creatorEmail ? 'creator' : 'actor';

  if (!to) {
    throw new Error('scheduler_email or creator email is required before sending the participation summary.');
  }

  const ccRecipients = await buildCcRecipients(to);
  const textBody = buildPostEventParticipationSummaryText(report);
  const subject = `Participation Summary: ${report.event.title}`;
  const htmlBody = [
    '<p>Hello,</p>',
    '<p>This post-event summary captures who was assigned, who participated, and who did not attend so you can close the loop on the event.</p>',
    `<p>Summary prepared by ${escapeHtml(args.actor)}.</p>`,
    `<pre>${escapeHtml(textBody)}</pre>`,
  ].join('');

  await notificationService.sendEmail({
    to,
    cc: ccRecipients,
    subject,
    htmlBody,
    textBody,
    eventId: report.event.event_id,
    operationType: 'event_participation_summary_email',
    operationReason: args.operationReason,
  });

  return { to, cc: ccRecipients, fallbackUsed };
}