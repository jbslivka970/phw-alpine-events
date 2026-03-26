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
      <p style="margin:16px 0 8px;"><strong>RSVP in one click:</strong></p>
      <p style="margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px;">
        <a href="{{yesUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#155724;color:#ffffff;text-decoration:none;">Yes</a>
        <a href="{{noUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#721c24;color:#ffffff;text-decoration:none;">No</a>
        <a href="{{maybeUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#856404;color:#ffffff;text-decoration:none;">Maybe</a>
        <a href="{{waitlistUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#383d41;color:#ffffff;text-decoration:none;">Waitlist</a>
      </p>
      <p><a href="{{rsvpUrl}}">Open RSVP Page</a></p>
      <p style="margin-top:20px;">Project Healing Waters Fly Fishing — Colorado Alpine Chapter</p>
      <p style="font-size:12px;color:#6b7280;">You are receiving this email because you are part of PHW Alpine communications.</p>
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
    { name: 'yesUrl', description: 'One-click yes RSVP URL', required: true },
    { name: 'noUrl', description: 'One-click no RSVP URL', required: true },
    { name: 'maybeUrl', description: 'One-click maybe RSVP URL', required: true },
    { name: 'waitlistUrl', description: 'One-click waitlist RSVP URL', required: true },
  ],
};

export { eventInviteTemplate };
