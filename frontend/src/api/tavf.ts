import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export type PostingStatus = 'open' | 'filled' | 'cancelled';
export type ApplicationStatus = 'pending' | 'matched' | 'waitlisted' | 'withdrawn';
export type MatchStatus = 'confirmed' | 'cancelled';

export interface TavfPosting {
  posting_id: string;
  guide_member_id: string;
  event_date: string;
  location: string;
  capacity: number;
  species?: string | null;
  description?: string | null;
  status: PostingStatus;
  created_at: string;
  updated_at: string;
}

export interface TavfApplication {
  application_id: string;
  posting_id: string;
  vet_member_id: string;
  notes?: string | null;
  status: ApplicationStatus;
  applied_at: string;
  updated_at: string;
}

export interface TavfMatch {
  match_id: string;
  posting_id: string;
  application_id: string;
  matched_by?: string | null;
  matched_at: string;
  status: MatchStatus;
  notes?: string | null;
}

const tavfApi = {
  // Postings
  listPostings: (status?: PostingStatus) =>
    apiGet<TavfPosting[]>(status ? `/tavf/postings?status=${encodeURIComponent(status)}` : '/tavf/postings'),

  getPosting: (id: string) =>
    apiGet<TavfPosting>(`/tavf/postings/${id}`),

  createPosting: (data: {
    guide_member_id?: string;
    event_date: string;
    location: string;
    capacity: number;
    species?: string;
    description?: string;
  }) => apiPost<TavfPosting>('/tavf/postings', data),

  updatePosting: (id: string, data: {
    event_date?: string;
    location?: string;
    capacity?: number;
    species?: string;
    description?: string;
    status?: PostingStatus;
  }) => apiPatch<TavfPosting>(`/tavf/postings/${id}`, data),

  deletePosting: (id: string) =>
    apiDelete<void>(`/tavf/postings/${id}`),

  // Applications
  listApplications: (postingId: string) =>
    apiGet<TavfApplication[]>(`/tavf/postings/${postingId}/applications`),

  applyToPosting: (postingId: string, data: {
    vet_member_id: string;
    notes?: string;
  }) => apiPost<TavfApplication>(`/tavf/postings/${postingId}/applications`, data),

  updateApplicationStatus: (applicationId: string, status: ApplicationStatus) =>
    apiPatch<TavfApplication>(`/tavf/applications/${applicationId}/status`, { status }),

  // Matches
  listMatches: () =>
    apiGet<TavfMatch[]>('/tavf/matches'),

  createMatch: (data: {
    posting_id: string;
    application_id: string;
    matched_by?: string;
    notes?: string;
  }) => apiPost<TavfMatch>('/tavf/matches', data),

  deleteMatch: (id: string) =>
    apiDelete<void>(`/tavf/matches/${id}`),
};

export default tavfApi;
