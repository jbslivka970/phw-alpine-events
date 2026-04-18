import { NotificationTemplate } from './NotificationTemplate';

const assignmentAdminAddedTemplate: NotificationTemplate = {
  templateId: 'assignment-admin-added',
  displayName: 'Assignment Admin Added',
  channel: 'both',
  subjectTemplate: "You've Been Added: {{eventName}} — {{eventDate}}",
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>An admin has added you to <strong>{{eventName}}</strong> on <strong>{{eventDate}}</strong>.</p>
      <p><strong>Role:</strong> {{role}}</p>
      <p>If you feel this is in error, please contact the Program Lead or one of the APLs.</p>
      <p>The event coordinator will reach out with further information including logistics and what to bring.</p>
      <p style="margin-top:20px;">PHW Colorado Alpine</p>
    </div>
  `,
  textBodyTemplate:
    "Hi {{firstName}},\n\nAn admin has added you to {{eventName}} on {{eventDate}}.\nRole: {{role}}\n\nIf you feel this is in error, please contact the Program Lead or one of the APLs.\n\nPHW Colorado Alpine",
  smsBodyTemplate:
    "PHW Alpine: You've been added to {{eventName}} on {{eventDate}} ({{role}}). If this is in error, contact the Program Lead. The coordinator will reach out with details.",
  variables: [
    { name: 'firstName', description: "Recipient's first name", required: true },
    { name: 'eventName', description: 'Name of the event', required: true },
    { name: 'eventDate', description: 'Formatted event date/time', required: true },
    { name: 'role', description: 'Assigned role (Mentor/Participant)', required: true },
  ],
};

export { assignmentAdminAddedTemplate };
