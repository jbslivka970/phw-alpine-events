import { NotificationTemplate } from './NotificationTemplate';

const assignmentConfirmationTemplate: NotificationTemplate = {
  templateId: 'assignment-confirmation',
  displayName: 'Assignment Confirmation',
  channel: 'both',
  subjectTemplate: "You're Confirmed: {{eventName}} — {{eventDate}}",
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>Great news! You have been <strong>confirmed</strong> for <strong>{{eventName}}</strong> on <strong>{{eventDate}}</strong>.</p>
      <p><strong>Role:</strong> {{role}}</p>
      <p>The event coordinator will reach out with further information including logistics and what to bring.</p>
      <p>We look forward to seeing you there!</p>
      <p style="margin-top:20px;">PHW Colorado Alpine</p>
    </div>
  `,
  textBodyTemplate:
    "Hi {{firstName}},\n\nYou have been confirmed for {{eventName}} on {{eventDate}}.\nRole: {{role}}\n\nThe event coordinator will reach out with further information.\n\nPHW Colorado Alpine",
  smsBodyTemplate:
    "PHW Alpine: You're CONFIRMED for {{eventName}} on {{eventDate}} ({{role}}). The event coordinator will reach out with details.",
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'role', description: 'Assigned role (Mentor/Participant)', required: true },
  ],
};

export { assignmentConfirmationTemplate };
