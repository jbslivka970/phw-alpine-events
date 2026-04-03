import { NotificationTemplate } from './NotificationTemplate';

const eventThankYouTemplate: NotificationTemplate = {
  templateId: 'event-thank-you',
  displayName: 'Event Thank You',
  channel: 'both',
  subjectTemplate: 'Thank you for joining {{eventTitle}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>Thank you for taking part in <strong>{{eventTitle}}</strong>.</p>
      <p>We appreciate your support and the time you gave to the chapter community.</p>
      <div style="border:1px solid #dbe3ee;border-radius:10px;padding:12px 14px;background:#f8fbff;">
        <p style="margin:0 0 6px 0;"><strong>Event:</strong> {{eventTitle}}</p>
        <p style="margin:0 0 6px 0;"><strong>Date:</strong> {{eventDate}}</p>
        <p style="margin:0;"><strong>Location:</strong> {{location}}</p>
      </div>
      <p style="margin:14px 0 0;">{{description}}</p>
      <p style="margin:16px 0 0;">You can review upcoming outings any time in the events calendar.</p>
      <p style="margin:16px 0 0;"><a href="{{rsvpUrl}}">View events</a></p>
      <p style="margin:18px 0 0;">Project Healing Waters Fly Fishing - Colorado Alpine Chapter</p>
    </div>
  `,
  textBodyTemplate:
    'Hi {{firstName}},\n\nThank you for joining {{eventTitle}}.\nDate: {{eventDate}}\nLocation: {{location}}\n\n{{description}}\n\nSee upcoming events: {{rsvpUrl}}\n\nProject Healing Waters Fly Fishing - Colorado Alpine Chapter',
  smsBodyTemplate:
    'PHW Alpine: Thanks for joining {{eventTitle}} at {{location}}. More events: {{rsvpUrl}} Reply STOP to opt out',
  variables: [
    { name: 'firstName', description: 'Recipient first name', required: true },
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: true },
    { name: 'description', description: 'Event description', required: true },
    { name: 'rsvpUrl', description: 'Events/RSVP link', required: true },
  ],
};

export { eventThankYouTemplate };
