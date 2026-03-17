import { getPool } from '../db';
import { notificationService } from '../services/notifications';
import { renderTemplate } from '../templates/NotificationTemplate';
import { eventReminderTemplate } from '../templates/eventReminder';

interface UpcomingEventRow {
  event_id: string;
  title: string;
  event_date: Date;
  location: string | null;
  member_id: string;
  first_name: string;
  email: string;
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
            m.member_id,
            m.first_name,
            m.email,
            m.mobile_phone,
            m.sms_opt_in
     FROM event e
     INNER JOIN event_response er ON er.event_id = e.event_id
     INNER JOIN member m ON m.member_id = er.member_id
     WHERE e.status = 'published'
       AND er.response = 'yes'
       AND e.event_date BETWEEN GETUTCDATE() AND DATEADD(HOUR, @lookAheadHours, GETUTCDATE())
       AND m.is_active = 1
       AND (m.email_opt_out = 0 OR m.email_opt_out IS NULL)`
  );

  for (const row of result.recordset) {
    const variables = {
      firstName: row.first_name,
      eventName: row.title,
      eventDate: row.event_date.toLocaleString(),
      eventLocation: row.location ?? '',
    };

    await notificationService.sendEmail({
      to: row.email,
      subject: renderTemplate(eventReminderTemplate.subjectTemplate ?? '', variables),
      htmlBody: renderTemplate(eventReminderTemplate.htmlBodyTemplate ?? '', variables),
      textBody: renderTemplate(eventReminderTemplate.textBodyTemplate ?? '', variables),
      templateId: eventReminderTemplate.templateId,
      memberId: row.member_id,
      eventId: row.event_id,
    });

    if (row.sms_opt_in && row.mobile_phone) {
      await notificationService.sendSms({
        to: row.mobile_phone,
        message: renderTemplate(eventReminderTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventReminderTemplate.templateId,
        memberId: row.member_id,
        eventId: row.event_id,
      });
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