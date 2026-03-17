import { NotificationTemplate } from './NotificationTemplate';

const rsvpConfirmationTemplate: NotificationTemplate = {
  templateId: 'rsvp-confirmation',
  displayName: 'RSVP Confirmation',
  channel: 'both',
  subjectTemplate: 'Your RSVP for {{eventName}} is confirmed',
  htmlBodyTemplate:
    '<p>Hi {{firstName}},</p><p>Thank you for registering for <strong>{{eventName}}</strong> on <strong>{{eventDate}}</strong>.</p><p>Your RSVP status: <strong>{{rsvpStatus}}</strong></p><p>PHW Alpine Events Team</p>',
  textBodyTemplate:
    'Hi {{firstName}},\n\nThank you for registering for {{eventName}} on {{eventDate}}.\nYour RSVP status: {{rsvpStatus}}\n\nPHW Alpine Events Team',
  smsBodyTemplate: 'PHW Events: RSVP confirmed for {{eventName}} on {{eventDate}}. Status: {{rsvpStatus}}.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'rsvpStatus', description: 'RSVP status', required: true },
  ],
};

export { rsvpConfirmationTemplate };