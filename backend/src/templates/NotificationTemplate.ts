interface NotificationTemplateVariable {
  name: string;
  description: string;
  required: boolean;
}

interface NotificationTemplate {
  templateId: string;
  displayName: string;
  channel: 'email' | 'sms' | 'both';
  subjectTemplate?: string;
  htmlBodyTemplate?: string;
  textBodyTemplate?: string;
  smsBodyTemplate?: string;
  variables: NotificationTemplateVariable[];
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? '');
}

export { renderTemplate };
export type { NotificationTemplate, NotificationTemplateVariable };