import { getPool } from '../db';
import { notificationService } from '../services/notifications';
import { renderTemplate } from '../templates/NotificationTemplate';
import { eventReminderTemplate } from '../templates/eventReminder';

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

async function runReminderJob(lookAheadHours = 48): Promise<void> {
  const pool = await getPool();
  const result = await pool.request().input('lookAheadHours', lookAheadHours).query<UpcomingEventRow>(
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
     FROM event e
     INNER JOIN event_response er ON er.event_id = e.event_id
     INNER JOIN member m ON m.member_id = er.member_id
     WHERE e.status = 'published'
       AND er.response = 'yes'
       AND ISNULL(er.reminder_sent, 0) = 0
       AND e.event_date BETWEEN GETUTCDATE() AND DATEADD(HOUR, @lookAheadHours, GETUTCDATE())
       AND m.is_active = 1
       AND (
         ISNULL(m.email_opt_out, 0) = 0
         OR (m.sms_opt_in = 1 AND m.mobile_phone IS NOT NULL)
       )`
  );

  for (const row of result.recordset) {
    const variables = {
      firstName: row.first_name,
      eventName: row.title,
      eventDate: row.event_date.toLocaleString(),
      eventLocation: row.location ?? '',
    };

    let delivered = false;

    if (!row.email_opt_out && row.email) {
      await notificationService.sendEmail({
        to: row.email,
        subject: renderTemplate(eventReminderTemplate.subjectTemplate ?? '', variables),
        htmlBody: renderTemplate(eventReminderTemplate.htmlBodyTemplate ?? '', variables),
        textBody: renderTemplate(eventReminderTemplate.textBodyTemplate ?? '', variables),
        templateId: eventReminderTemplate.templateId,
        memberId: row.member_id,
        eventId: row.event_id,
      });
      delivered = true;
    }

    if (row.sms_opt_in && row.mobile_phone) {
      await notificationService.sendSms({
        to: row.mobile_phone,
        message: renderTemplate(eventReminderTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventReminderTemplate.templateId,
        memberId: row.member_id,
        eventId: row.event_id,
      });
      delivered = true;
    }

    if (delivered) {
      await pool
        .request()
        .input('response_id', row.response_id)
        .query(
          `UPDATE event_response
           SET reminder_sent = 1,
               reminder_sent_at = GETUTCDATE()
           WHERE response_id = @response_id`
        );
    }
  }
}

if (require.main === module) {
  runReminderJob().catch((error) => {
    console.error('Reminder job failed', error);
    process.exit(1);
  });
}

export { runReminderJob };