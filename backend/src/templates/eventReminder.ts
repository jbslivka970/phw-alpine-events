import { NotificationTemplate } from './NotificationTemplate';

const eventReminderTemplate: NotificationTemplate = {
  templateId: 'event-reminder',
  displayName: 'Event Reminder',
  channel: 'both',
  subjectTemplate: 'Reminder: {{eventName}} · {{eventDate}}',
  htmlBodyTemplate:
    '<p style="margin:0 0 8px;">Hi {{firstName}},</p><p style="margin:0 0 8px;">Quick reminder: <strong>{{eventName}}</strong> is on <strong>{{eventDate}}</strong> at <strong>{{eventLocation}}</strong>.</p><p style="margin:0 0 8px;"><a href="{{mapUrl}}">View map</a></p><p style="margin:0;">Thanks for RSVP\'ing. See you there.</p>',
  textBodyTemplate:
    'Hi {{firstName}},\n\nQuick reminder: {{eventName}} is on {{eventDate}} at {{eventLocation}}.\nMap: {{mapUrl}}\n\nThanks for RSVP\'ing. See you there.',
  smsBodyTemplate: 'PHW Events: Reminder - {{eventName}} on {{eventDate}} at {{eventLocation}}.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'eventLocation', description: 'Event location', required: false },
    { name: 'mapUrl', description: 'Google Maps URL', required: false },
  ],
};

export { eventReminderTemplate };