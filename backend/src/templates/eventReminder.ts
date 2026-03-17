import { NotificationTemplate } from './NotificationTemplate';

const eventReminderTemplate: NotificationTemplate = {
  templateId: 'event-reminder',
  displayName: 'Event Reminder',
  channel: 'both',
  subjectTemplate: 'Reminder: {{eventName}} is coming up on {{eventDate}}',
  htmlBodyTemplate:
    '<p>Hi {{firstName}},</p><p>This is a friendly reminder that <strong>{{eventName}}</strong> is scheduled for <strong>{{eventDate}}</strong> at <strong>{{eventLocation}}</strong>.</p><p>We look forward to seeing you there.</p><p>PHW Alpine Events Team</p>',
  textBodyTemplate:
    'Hi {{firstName}},\n\nThis is a friendly reminder that {{eventName}} is scheduled for {{eventDate}} at {{eventLocation}}.\n\nWe look forward to seeing you there.\n\nPHW Alpine Events Team',
  smsBodyTemplate: 'PHW Events: Reminder - {{eventName}} on {{eventDate}} at {{eventLocation}}.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'eventLocation', description: 'Event location', required: false },
  ],
};

export { eventReminderTemplate };