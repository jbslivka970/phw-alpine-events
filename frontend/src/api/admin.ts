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

const adminApi = {
  generateInviteDraft: (payload: InviteDraftRequest) =>
    apiPost<InviteDraftResponse>('/admin/ai/invite-draft', payload),
};

export { adminApi };
export type { InviteDraftRequest, InviteDraftResponse };
