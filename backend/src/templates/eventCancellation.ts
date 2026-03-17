import { NotificationTemplate } from './NotificationTemplate';

const eventCancellationTemplate: NotificationTemplate = {
  templateId: 'event-cancellation',
  displayName: 'Event Cancellation',
  channel: 'both',
  subjectTemplate: '[CANCELLED] {{eventTitle}} — {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hey PHW Colorado Alpine Family,</p>
      <p>We need to let you know that <strong>{{eventTitle}}</strong> scheduled for <strong>{{eventDate}}</strong> has been cancelled.</p>
      <p>Location: {{location}}</p>
      <p>Please watch for updates on future events.</p>
      <p style="margin-top:20px;">Project Healing Waters Fly Fishing — Colorado Alpine Chapter</p>
    </div>
  `,
  textBodyTemplate:
    'PHW Alpine update: {{eventTitle}} on {{eventDate}} has been cancelled. Location: {{location}}. Please watch for future updates.',
  smsBodyTemplate: 'PHW Alpine: {{eventTitle}} on {{eventDate}} has been CANCELLED.',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: true },
  ],
};

export { eventCancellationTemplate };
