import { NotificationTemplate } from './NotificationTemplate';

const eventCancellationTemplate: NotificationTemplate = {
  templateId: 'event-cancellation',
  displayName: 'Event Cancellation',
  channel: 'both',
  subjectTemplate: '[CANCELLED] {{eventTitle}} — {{eventDate}}',
  htmlBodyTemplate: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>PHW Alpine Events</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#1a5276;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:24px;">PHW Colorado Alpine Chapter</h1>
    <p style="color:#aed6f1;margin:5px 0 0;">Project Healing Waters Fly Fishing</p>
  </div>
  <div style="background:#f8f9fa;padding:30px;border:1px solid #dee2e6;border-top:none;">
    <p>Hey PHW Colorado Alpine Family,</p>
    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:20px;margin:20px 0;">
      <h2 style="color:#856404;margin-top:0;">⚠️ Event Cancelled</h2>
      <p><strong>{{eventTitle}}</strong> scheduled for <strong>{{eventDate}}</strong> has been <strong>cancelled</strong>.</p>
      <p>📍 <strong>Location:</strong> {{location}}</p>
    </div>
    <p>We apologize for any inconvenience. Please watch for future event announcements.</p>
    <p>Tight lines,<br><strong>PHW Alpine Events Team</strong></p>
  </div>
  <div style="background:#f1f1f1;padding:15px;border-radius:0 0 8px 8px;text-align:center;font-size:12px;color:#666;">
    <p style="margin:0;">Project Healing Waters Fly Fishing — Colorado Alpine Chapter</p>
  </div>
</body>
</html>`,
  textBodyTemplate: `Hey PHW Colorado Alpine Family,

IMPORTANT: {{eventTitle}} scheduled for {{eventDate}} has been CANCELLED.

Location: {{location}}

We apologize for any inconvenience.

Tight lines,
PHW Alpine Events Team

---
Project Healing Waters Fly Fishing — Colorado Alpine Chapter`,
  smsBodyTemplate: 'PHW Alpine: {{eventTitle}} on {{eventDate}} has been CANCELLED.',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: false },
  ],
};

export { eventCancellationTemplate };
