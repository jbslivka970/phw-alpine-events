import { NotificationTemplate } from './NotificationTemplate';

const rsvpWaitlistedTemplate: NotificationTemplate = {
  templateId: 'rsvp-waitlisted',
  displayName: 'RSVP Waitlisted',
  channel: 'both',
  subjectTemplate: 'Waitlisted: {{eventName}} — {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>Thank you for your interest in <strong>{{eventName}}</strong> on <strong>{{eventDate}}</strong>.</p>
      <p>This event is currently at capacity and you have been placed on the <strong>waitlist</strong>. If a spot opens up, you will be notified.</p>
      <p>No action is needed on your part.</p>
      <p>Thank you for your patience!</p>
      <p style="margin-top:20px;">PHW Colorado Alpine</p>
    </div>
  `,
  textBodyTemplate:
    'Hi {{firstName}},\n\nThank you for your interest in {{eventName}} on {{eventDate}}.\nThis event is at capacity. You have been placed on the waitlist and will be notified if a spot opens.\n\nPHW Colorado Alpine',
  smsBodyTemplate:
    'PHW Alpine: {{eventName}} on {{eventDate}} is at capacity. You\'re on the waitlist — we\'ll notify you if a spot opens.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
  ],
};

export { rsvpWaitlistedTemplate };
