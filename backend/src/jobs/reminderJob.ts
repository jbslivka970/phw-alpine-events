import { getPool } from '../db';
import { notificationService } from '../services/notifications';
import { renderTemplate } from '../templates/NotificationTemplate';
import { eventReminderTemplate } from '../templates/eventReminder';
import { randomUUID } from 'crypto';

const REMINDER_CLAIM_TIMEOUT_MINUTES = 30;

interface UpcomingEventRow {
  event_id: string;
  title: string;
  event_date: Date;
  location: string | null;
  response_id: string;
  member_id: string;
  first_name: string;
  email: string;
  email_opt_out: boolean;
  mobile_phone: string | null;
  sms_opt_in: boolean;
}

interface RuntimeTemplateOverride {
  subject: string | null;
  body: string;
}

function stripHtmlToText(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getActiveTemplateOverride(
  pool: Awaited<ReturnType<typeof getPool>>,
  templateName: string,
  channel: 'email' | 'sms'
): Promise<RuntimeTemplateOverride | null> {
  try {
    const result = await pool
      .request()
      .input('template_name', templateName)
      .input('channel', channel)
      .query<{ subject: string | null; body: string }>(
        `SELECT TOP 1 subject, body
         FROM notification_template
         WHERE template_name = @template_name
           AND channel = @channel
           AND is_active = 1
         ORDER BY updated_at DESC`
      );

    const row = result.recordset?.[0];
    return row ? { subject: row.subject, body: row.body } : null;
  } catch (error) {
    console.warn('[reminderJob] failed to load runtime template override; using built-in template', {
      templateName,
      channel,
      error,
    });
    return null;
  }
}

async function runReminderJob(lookAheadHours = 48): Promise<void> {
  const pool = await getPool();
  const claimToken = randomUUID();
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(pool, eventReminderTemplate.displayName, 'email'),
    getActiveTemplateOverride(pool, eventReminderTemplate.displayName, 'sms'),
  ]);

  await pool
    .request()
    .input('lookAheadHours', lookAheadHours)
    .input('claimToken', claimToken)
    .input('claimTimeoutMinutes', REMINDER_CLAIM_TIMEOUT_MINUTES)
    .query(
      `UPDATE er
       SET er.reminder_claimed_at = GETUTCDATE(),
           er.reminder_claim_token = @claimToken
       FROM event_response er
       INNER JOIN event e ON e.event_id = er.event_id
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE e.status = 'published'
         AND er.response = 'yes'
         AND ISNULL(er.reminder_sent, 0) = 0
         AND e.event_date BETWEEN GETUTCDATE() AND DATEADD(HOUR, @lookAheadHours, GETUTCDATE())
         AND m.is_active = 1
         AND (
           ISNULL(m.email_opt_out, 0) = 0
           OR (m.sms_opt_in = 1 AND m.mobile_phone IS NOT NULL)
         )
         AND (
           er.reminder_claimed_at IS NULL
           OR er.reminder_claimed_at < DATEADD(MINUTE, -@claimTimeoutMinutes, GETUTCDATE())
         )`
    );

  const result = await pool
    .request()
    .input('claimToken', claimToken)
    .query<UpcomingEventRow>(
      `SELECT e.event_id,
              e.title,
              e.event_date,
              e.location,
              er.response_id,
              m.member_id,
              m.first_name,
              m.email,
              ISNULL(m.email_opt_out, 0) AS email_opt_out,
              m.mobile_phone,
              m.sms_opt_in
       FROM event_response er
       INNER JOIN event e ON e.event_id = er.event_id
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE er.reminder_claim_token = @claimToken`
    );

  let attempted = 0;
  let deliveredCount = 0;
  let failedCount = 0;

  for (const row of result.recordset) {
    attempted += 1;
    const variables = {
      firstName: row.first_name,
      eventName: row.title,
      eventDate: row.event_date.toLocaleString(),
      eventLocation: row.location ?? '',
    };

    let delivered = false;

    try {
      if (!row.email_opt_out && row.email) {
        try {
          const emailHtmlBody = renderTemplate(
            emailTemplateOverride?.body ?? eventReminderTemplate.htmlBodyTemplate ?? '',
            variables
          );
          const emailSubjectSource = emailTemplateOverride?.subject?.trim()
            ? emailTemplateOverride.subject
            : eventReminderTemplate.subjectTemplate ?? '';
          await notificationService.sendEmail({
            to: row.email,
            subject: renderTemplate(emailSubjectSource, variables),
            htmlBody: emailHtmlBody,
            textBody: emailTemplateOverride
              ? stripHtmlToText(emailHtmlBody)
              : renderTemplate(eventReminderTemplate.textBodyTemplate ?? '', variables),
            templateId: eventReminderTemplate.templateId,
            memberId: row.member_id,
            eventId: row.event_id,
            operationType: 'event_reminder',
            operationReason: `lookahead_${lookAheadHours}h`,
          });
          delivered = true;
        } catch (error) {
          console.error('[reminderJob] email send failed', {
            memberId: row.member_id,
            eventId: row.event_id,
            responseId: row.response_id,
            error,
          });
        }
      }

      if (row.sms_opt_in && row.mobile_phone) {
        try {
          await notificationService.sendSms({
            to: row.mobile_phone,
            message: renderTemplate(smsTemplateOverride?.body ?? eventReminderTemplate.smsBodyTemplate ?? '', variables),
            templateId: eventReminderTemplate.templateId,
            memberId: row.member_id,
            eventId: row.event_id,
            operationType: 'event_reminder',
            operationReason: `lookahead_${lookAheadHours}h`,
          });
          delivered = true;
        } catch (error) {
          console.error('[reminderJob] sms send failed', {
            memberId: row.member_id,
            eventId: row.event_id,
            responseId: row.response_id,
            error,
          });
        }
      }

      if (delivered) {
        const markResult = await pool
          .request()
          .input('response_id', row.response_id)
          .input('claimToken', claimToken)
          .query(
            `UPDATE event_response
             SET reminder_sent = 1,
                 reminder_sent_at = GETUTCDATE(),
                 reminder_claimed_at = NULL,
                 reminder_claim_token = NULL
             WHERE response_id = @response_id
               AND reminder_claim_token = @claimToken`
          );

        if ((markResult.rowsAffected?.[0] ?? 0) > 0) {
          deliveredCount += 1;
        } else {
          failedCount += 1;
        }
      } else {
        await releaseReminderClaim(pool, row.response_id, claimToken);
        failedCount += 1;
      }
    } catch (error) {
      await releaseReminderClaim(pool, row.response_id, claimToken);
      failedCount += 1;
      console.error('[reminderJob] row processing failed', {
        memberId: row.member_id,
        eventId: row.event_id,
        responseId: row.response_id,
        error,
      });
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'reminder_job_completed',
    lookAheadHours,
    attempted,
    delivered: deliveredCount,
    failed: failedCount,
    timestamp: new Date().toISOString(),
  }));
}

async function releaseReminderClaim(pool: Awaited<ReturnType<typeof getPool>>, responseId: string, claimToken: string): Promise<void> {
  await pool
    .request()
    .input('response_id', responseId)
    .input('claimToken', claimToken)
    .query(
      `UPDATE event_response
       SET reminder_claimed_at = NULL,
           reminder_claim_token = NULL
       WHERE response_id = @response_id
         AND reminder_claim_token = @claimToken
         AND ISNULL(reminder_sent, 0) = 0`
    );
}

if (require.main === module) {
  runReminderJob().catch((error) => {
    console.error('Reminder job failed', error);
    process.exit(1);
  });
}

export { runReminderJob };