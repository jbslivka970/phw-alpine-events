import { NotificationTemplate } from './NotificationTemplate';

const rsvpConfirmationTemplate: NotificationTemplate = {
  templateId: 'rsvp-confirmation',
  displayName: 'RSVP Confirmation',
  channel: 'both',
  subjectTemplate: 'RSVP Confirmed: {{eventName}} — {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>Your RSVP is confirmed for <strong>{{eventName}}</strong>.</p>
      <p><strong>Date:</strong> {{eventDate}}</p>
      <p><strong>Status:</strong> {{rsvpStatus}}</p>
      <p>Thanks for staying connected with Project Healing Waters Fly Fishing — Colorado Alpine Chapter.</p>
    </div>
  `,
  textBodyTemplate:
    'Hi {{firstName}},\n\nYour RSVP is confirmed for {{eventName}} on {{eventDate}}.\nStatus: {{rsvpStatus}}\n\nProject Healing Waters Fly Fishing - Colorado Alpine Chapter',
  smsBodyTemplate: 'PHW Events: RSVP confirmed for {{eventName}} on {{eventDate}}. Status: {{rsvpStatus}}.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'rsvpStatus', description: 'RSVP status', required: true },
  ],
};

export { rsvpConfirmationTemplate };