import { NotificationTemplate } from './NotificationTemplate';

const rsvpConfirmationTemplate: NotificationTemplate = {
  templateId: 'rsvp-confirmation',
  displayName: 'RSVP Confirmation',
  channel: 'both',
  subjectTemplate: 'RSVP Confirmed: {{eventName}} — {{eventDate}}',
  htmlBodyTemplate: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>RSVP Confirmation</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#1a5276;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:24px;">PHW Colorado Alpine Chapter</h1>
  </div>
  <div style="background:#f8f9fa;padding:30px;border:1px solid #dee2e6;border-top:none;">
    <p>Hi {{firstName}},</p>
    <p>Your RSVP has been received for <strong>{{eventName}}</strong>.</p>
    <div style="background:#fff;border:1px solid #dee2e6;border-radius:6px;padding:20px;margin:20px 0;">
      <p>📅 <strong>Date:</strong> {{eventDate}}</p>
      <p>✅ <strong>Status:</strong> {{rsvpStatus}}</p>
    </div>
    <p>We look forward to seeing you there!</p>
    <p>Tight lines,<br><strong>PHW Alpine Events Team</strong></p>
  </div>
</body>
</html>`,
  textBodyTemplate:
    'Hi {{firstName}},\n\nYour RSVP has been received for {{eventName}} on {{eventDate}}.\nStatus: {{rsvpStatus}}\n\nTight lines,\nPHW Alpine Events Team',
  smsBodyTemplate: 'PHW Alpine: RSVP confirmed for {{eventName}} on {{eventDate}}. Status: {{rsvpStatus}}.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'rsvpStatus', description: 'RSVP status', required: true },
  ],
};

export { rsvpConfirmationTemplate };