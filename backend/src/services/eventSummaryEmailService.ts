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

function buildLeadPrepSummaryText(report: EventSummaryReportData): string {
  const yesCount = report.responses.filter((row) => row.response === 'yes').length;
  const maybeCount = report.responses.filter((row) => row.response === 'maybe').length;
  const waitlistCount = report.responses.filter((row) => row.response === 'waitlist').length;
  const noCount = report.responses.filter((row) => row.response === 'no').length;
  const assignmentLines = report.assignments.length === 0
    ? ['- none']
    : report.assignments.map((row) => `- ${row.first_name} ${row.last_name} (${row.role}) | ${formatContact(row.email, row.mobile_phone)}`);
  const responseLines = report.responses.length === 0
    ? ['- none']
    : report.responses.map((row) => `- ${row.first_name} ${row.last_name}: ${row.response}${row.response_role ? ` (${row.response_role})` : ''} | ${formatContact(row.email, row.mobile_phone)}`);

  return [
    'Hi there,',
    '',
    'Thanks for leading this event. This summary includes everyone who signed up, the role they were assigned, and their contact information so you can coordinate prep and follow up as needed.',
    'The Program Lead and Assistant Program Leads are CC\'d on this email and can help answer questions so the event is ready to go.',
    '',
    `Event: ${report.event.title}`,
    `Status: ${report.event.status}`,
    `Start: ${formatReportTimestamp(report.event.event_date)}`,
    `End: ${formatReportTimestamp(report.event.end_date) || 'n/a'}`,
    `Location: ${report.event.location ?? 'n/a'}`,
    '',
    'RSVP Snapshot',
    `- Assigned: ${report.assignments.length}`,
    `- RSVP Yes: ${yesCount}`,
    `- RSVP Maybe: ${maybeCount}`,
    `- RSVP Waitlist: ${waitlistCount}`,
    `- RSVP No: ${noCount}`,
    '',
    'Assigned Roster',
    ...assignmentLines,
    '',
    'All RSVP Responses',
    ...responseLines,
    '',
    `Generated at: ${new Date().toISOString()}`,
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
  const htmlBody = [
    '<p>Hi there,</p>',
    '<p>Thanks for leading this event. This summary includes everyone who signed up, the role they were assigned, and their contact information so you can coordinate prep and follow up as needed. The Program Lead and Assistant Program Leads are CC&#39;d on this email and can help answer questions so the event is ready to go.</p>',
    `<p>Summary prepared by ${escapeHtml(args.actor)}.</p>`,
    `<pre>${escapeHtml(textBody)}</pre>`,
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