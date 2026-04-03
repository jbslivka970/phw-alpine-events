import { apiPost } from './client';

interface InviteDraftRequest {
  event_id?: string;
  title?: string;
  event_date?: string;
  location?: string | null;
  description?: string | null;
  tone?: 'friendly' | 'professional';
}

interface InviteDraftResponse {
  subject: string;
  emailBody: string;
  smsBody: string;
  provider: 'azure-openai' | 'openai' | 'fallback';
  source: 'event' | 'ad_hoc';
  tone: 'friendly' | 'professional';
}

interface ApplyInviteDraftRequest extends InviteDraftRequest {
  template_name?: string;
  approved: boolean;
  review_note?: string;
}

interface ApplyInviteDraftResponse {
  template_name: string;
  source: 'event' | 'ad_hoc';
  tone: 'friendly' | 'professional';
  provider: 'azure-openai' | 'openai' | 'fallback';
  approved: boolean;
  review_note: string | null;
  applied_by: string;
  applied_at: string;
  templates: {
    email: { template_id: string; updated_at: string };
    sms: { template_id: string; updated_at: string };
  };
}

interface RetentionPreviewRequest {
  notification_log_days?: number;
  inbound_sms_log_days?: number;
  email_preference_log_days?: number;
}

interface RetentionPreviewResult {
  target: 'notification_log' | 'inbound_sms_log' | 'email_preference_log';
  retentionDays: number;
  affectedRows: number;
  mode: 'dry-run';
}

interface RetentionPreviewResponse {
  generated_at: string;
  generated_by: string;
  mode: 'dry-run';
  results: RetentionPreviewResult[];
}

const adminApi = {
  generateInviteDraft: (payload: InviteDraftRequest) =>
    apiPost<InviteDraftResponse>('/admin/ai/invite-draft', payload),
  applyInviteDraftToTemplates: (payload: ApplyInviteDraftRequest) =>
    apiPost<ApplyInviteDraftResponse>('/admin/ai/invite-draft/apply', payload),
  previewRetention: (payload: RetentionPreviewRequest) =>
    apiPost<RetentionPreviewResponse>('/admin/retention/preview', payload),
};

export { adminApi };
export type {
  InviteDraftRequest,
  InviteDraftResponse,
  ApplyInviteDraftRequest,
  ApplyInviteDraftResponse,
  RetentionPreviewRequest,
  RetentionPreviewResponse,
};
