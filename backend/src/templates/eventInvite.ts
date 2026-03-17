import { NotificationTemplate } from './NotificationTemplate';

const eventInviteTemplate: NotificationTemplate = {
  templateId: 'event-invite',
  displayName: 'Event Invitation',
  channel: 'both',
  subjectTemplate: '🎣 {{eventTitle}} — {{eventDate}}',
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
    <p>We have an upcoming event we'd love to have you join!</p>
    <div style="background:#fff;border:1px solid #dee2e6;border-radius:6px;padding:20px;margin:20px 0;">
      <h2 style="color:#1a5276;margin-top:0;">{{eventTitle}}</h2>
      <p>📅 <strong>Date:</strong> {{eventDate}}</p>
      <p>⏰ <strong>Time:</strong> {{eventTime}}</p>
      <p>📍 <strong>Location:</strong> {{location}}</p>
      {{#if description}}<p>{{description}}</p>{{/if}}
    </div>
    <div style="text-align:center;margin:30px 0;">
      <a href="{{rsvpUrl}}" style="background:#1a5276;color:#fff;padding:12px 30px;border-radius:4px;text-decoration:none;font-weight:bold;">RSVP Now</a>
    </div>
    <p>We hope to see you there!</p>
    <p>Tight lines,<br><strong>PHW Alpine Events Team</strong></p>
  </div>
  <div style="background:#f1f1f1;padding:15px;border-radius:0 0 8px 8px;text-align:center;font-size:12px;color:#666;">
    <p style="margin:0;">Project Healing Waters Fly Fishing — Colorado Alpine Chapter</p>
    <p style="margin:5px 0 0;">To unsubscribe from event notifications, <a href="{{unsubscribeUrl}}" style="color:#1a5276;">click here</a>.</p>
  </div>
</body>
</html>`,
  textBodyTemplate: `Hey PHW Colorado Alpine Family,

We have an upcoming event we'd love to have you join!

{{eventTitle}}
Date: {{eventDate}}
Time: {{eventTime}}
Location: {{location}}

{{description}}

RSVP here: {{rsvpUrl}}

Tight lines,
PHW Alpine Events Team

---
Project Healing Waters Fly Fishing — Colorado Alpine Chapter
To unsubscribe: {{unsubscribeUrl}}`,
  smsBodyTemplate: 'PHW Alpine: {{eventTitle}} on {{eventDate}} at {{location}}. RSVP: {{rsvpUrl}} Reply STOP to opt out',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'eventTime', description: 'Formatted event time', required: false },
    { name: 'location', description: 'Event location', required: true },
    { name: 'description', description: 'Event description', required: false },
    { name: 'rsvpUrl', description: 'URL to RSVP', required: true },
    { name: 'unsubscribeUrl', description: 'Unsubscribe URL', required: false },
  ],
};

export { eventInviteTemplate };
