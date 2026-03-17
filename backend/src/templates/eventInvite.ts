import { NotificationTemplate } from './NotificationTemplate';

const eventInviteTemplate: NotificationTemplate = {
  templateId: 'event-invite',
  displayName: 'Event Invite',
  channel: 'both',
  subjectTemplate: '🎣 {{eventTitle}} — {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hey PHW Colorado Alpine Family,</p>
      <p>You're invited to our upcoming event.</p>
      <div style="border:1px solid #d1d5db;border-radius:8px;padding:12px 16px;background:#f9fafb;">
        <p style="margin:0 0 8px 0;"><strong>📅 Date:</strong> {{eventDate}}</p>
        <p style="margin:0 0 8px 0;"><strong>⏰ Time:</strong> {{eventDate}}</p>
        <p style="margin:0;"><strong>📍 Location:</strong> {{location}}</p>
      </div>
      <p style="margin-top:16px;">{{description}}</p>
      <p><a href="{{rsvpUrl}}">RSVP Here</a></p>
      <p style="margin-top:20px;">Project Healing Waters Fly Fishing — Colorado Alpine Chapter</p>
      <p style="font-size:12px;color:#6b7280;">You are receiving this email because you are part of PHW Alpine communications. To unsubscribe, update your email preferences in your member profile.</p>
    </div>
  `,
  textBodyTemplate:
    'Hey PHW Colorado Alpine Family,\n\n{{eventTitle}} is scheduled for {{eventDate}} at {{location}}.\n{{description}}\n\nRSVP: {{rsvpUrl}}\n\nProject Healing Waters Fly Fishing - Colorado Alpine Chapter',
  smsBodyTemplate:
    'PHW Alpine: {{eventTitle}} on {{eventDate}} at {{location}}. RSVP: {{rsvpUrl}} Reply STOP to opt out',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: true },
    { name: 'description', description: 'Event description', required: true },
    { name: 'rsvpUrl', description: 'RSVP URL', required: true },
  ],
};

export { eventInviteTemplate };
