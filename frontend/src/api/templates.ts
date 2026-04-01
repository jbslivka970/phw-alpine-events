import { apiDelete, apiGet, apiPatch, apiPost } from './client';

type TemplateChannel = 'email' | 'sms';

interface NotificationTemplateRecord {
  template_id: string;
  template_name: string;
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface UpsertTemplateInput {
  template_name: string;
  channel: TemplateChannel;
  subject?: string | null;
  body: string;
  is_active?: boolean;
}

interface TemplateVersionRecord {
  version_id: string;
  template_id: string;
  template_name: string;
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  action: 'update' | 'deactivate' | 'rollback_before' | 'rollback_applied';
  reason: string | null;
  changed_by: string | null;
  created_at: string;
}

const templatesApi = {
  list: (params?: { channel?: TemplateChannel; is_active?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.channel) query.set('channel', params.channel);
    if (params?.is_active !== undefined) query.set('is_active', String(params.is_active));
    const suffix = query.toString();
    return apiGet<NotificationTemplateRecord[]>(suffix ? `/templates?${suffix}` : '/templates');
  },
  create: (input: UpsertTemplateInput) => apiPost<NotificationTemplateRecord>('/templates', input),
  update: (templateId: string, input: Partial<UpsertTemplateInput>) => apiPatch<NotificationTemplateRecord>(`/templates/${templateId}`, input),
  deactivate: (templateId: string) => apiDelete<NotificationTemplateRecord>(`/templates/${templateId}`),
  history: (templateId: string) => apiGet<TemplateVersionRecord[]>(`/templates/${templateId}/history`),
  rollback: (templateId: string, payload: { version_id: string; approved: boolean; reason?: string }) =>
    apiPost<NotificationTemplateRecord>(`/templates/${templateId}/rollback`, payload),
};

export { templatesApi };
export type { NotificationTemplateRecord, TemplateChannel, UpsertTemplateInput, TemplateVersionRecord };
