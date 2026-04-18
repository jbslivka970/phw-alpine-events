import { NotificationTemplate } from './NotificationTemplate';

const rsvpConfirmationTemplate: NotificationTemplate = {
  templateId: 'rsvp-confirmation',
  displayName: 'RSVP Received',
  channel: 'both',
  subjectTemplate: 'RSVP Received: {{eventName}} — {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>We've received your RSVP for <strong>{{eventName}}</strong> on <strong>{{eventDate}}</strong>.</p>
      <p><strong>Your spot is not yet confirmed.</strong> Our event coordinator will review all RSVPs and confirm assignments. You will receive a separate email once you have been assigned to this event.</p>
      <p>Thank you for your interest!</p>
      <p style="margin-top:20px;">PHW Colorado Alpine</p>
    </div>
  `,
  textBodyTemplate:
    "Hi {{firstName}},\n\nWe've received your RSVP for {{eventName}} on {{eventDate}}.\n\nYour spot is not yet confirmed. You will receive a separate email once you have been assigned to this event.\n\nPHW Colorado Alpine",
  smsBodyTemplate: 'PHW Alpine: RSVP received for {{eventName}} on {{eventDate}}. Your spot is not yet confirmed — you\'ll get a separate email once assigned.',
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'rsvpStatus', description: 'RSVP status', required: true },
  ],
};

export { rsvpConfirmationTemplate };