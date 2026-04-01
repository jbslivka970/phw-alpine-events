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
  provider: 'openai' | 'fallback';
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
  provider: 'openai' | 'fallback';
  approved: boolean;
  review_note: string | null;
  applied_by: string;
  applied_at: string;
  templates: {
    email: { template_id: string; updated_at: string };
    sms: { template_id: string; updated_at: string };
  };
}

const adminApi = {
  generateInviteDraft: (payload: InviteDraftRequest) =>
    apiPost<InviteDraftResponse>('/admin/ai/invite-draft', payload),
  applyInviteDraftToTemplates: (payload: ApplyInviteDraftRequest) =>
    apiPost<ApplyInviteDraftResponse>('/admin/ai/invite-draft/apply', payload),
};

export { adminApi };
export type { InviteDraftRequest, InviteDraftResponse, ApplyInviteDraftRequest, ApplyInviteDraftResponse };
