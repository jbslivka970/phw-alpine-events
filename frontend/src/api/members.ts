import { apiDelete, apiGet, apiPatch, apiPost } from './client';

interface MemberRecord {
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone: string | null;
  sms_opt_in: boolean;
  email_opt_out: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ListMembersResponse {
  members: MemberRecord[];
  total: number;
  page: number;
  pageSize: number;
}

const membersApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; isActive?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.page) query.set('page', String(params.page));
    if (params?.pageSize) query.set('pageSize', String(params.pageSize));
    if (params?.search) query.set('search', params.search);
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    const suffix = query.toString();
    return apiGet<ListMembersResponse>(suffix ? `/members?${suffix}` : '/members');
  },
  get: (id: string) => apiGet<MemberRecord>(`/members/${id}`),
  groups: (id: string) => apiGet<unknown[]>(`/members/${id}/groups`),
  create: (data: Partial<MemberRecord>) => apiPost<MemberRecord>('/members', data),
  update: (id: string, data: Partial<MemberRecord>) => apiPatch<MemberRecord>(`/members/${id}`, data),
  remove: (id: string) => apiDelete<{ message: string; member: MemberRecord }>(`/members/${id}`),
};

export { membersApi };
export type { MemberRecord, ListMembersResponse };