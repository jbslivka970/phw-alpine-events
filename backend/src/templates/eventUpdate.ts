import { NotificationTemplate } from './NotificationTemplate';

const eventUpdateTemplate: NotificationTemplate = {
  templateId: 'event-update',
  displayName: 'Event Update',
  channel: 'both',
  subjectTemplate: '[UPDATED] {{eventTitle}} - {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hey PHW Colorado Alpine Family,</p>
      <p>We updated details for <strong>{{eventTitle}}</strong>.</p>
      <div style="border:1px solid #d1d5db;border-radius:8px;padding:12px 16px;background:#f9fafb;">
        <p style="margin:0 0 8px 0;"><strong>Date:</strong> {{eventDate}}</p>
        <p style="margin:0 0 8px 0;"><strong>Location:</strong> {{location}}</p>
        <p style="margin:0 0 8px 0;"><strong>Map:</strong> <a href="{{mapUrl}}">Open map</a></p>
        <p style="margin:0;"><strong>What changed:</strong> {{changeSummary}}</p>
      </div>
      <p style="margin-top:14px;"><strong>Reason:</strong> {{updateReason}}</p>
      <p style="margin-top:14px;">{{description}}</p>
      <p><a href="{{rsvpUrl}}">Review RSVP details</a></p>
      <p style="margin-top:20px;">PHW Colorado Alpine</p>
    </div>
  `,
  textBodyTemplate:
    'PHW Alpine update: {{eventTitle}} now reflects updated details. Date: {{eventDate}}. Location: {{location}}. Map: {{mapUrl}}. Changes: {{changeSummary}}. Reason: {{updateReason}}. RSVP: {{rsvpUrl}}',
  smsBodyTemplate:
    'PHW Alpine update: {{eventTitle}} changed ({{changeSummary}}). {{eventDate}} at {{location}}. {{updateReason}} RSVP: {{rsvpUrl}}',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: true },
    { name: 'mapUrl', description: 'Google Maps URL for event location', required: false },
    { name: 'description', description: 'Event description', required: true },
    { name: 'rsvpUrl', description: 'RSVP URL', required: true },
    { name: 'changeSummary', description: 'Summary of changed fields', required: true },
    { name: 'updateReason', description: 'Operator-supplied update reason', required: true },
  ],
};

export { eventUpdateTemplate };