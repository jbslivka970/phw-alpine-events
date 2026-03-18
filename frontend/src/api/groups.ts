import { apiDelete, apiGet, apiPatch, apiPost } from './client';

interface GroupRecord {
  group_id: string;
  group_name: string;
  description: string | null;
  is_system: boolean;
  created_at?: string;
}

const groupsApi = {
  list: () => apiGet<GroupRecord[]>('/groups'),
  get: (id: string) => apiGet<GroupRecord>(`/groups/${id}`),
  members: (id: string) => apiGet<string[]>(`/groups/${id}/members`),
  create: (data: { group_name: string; description?: string | null }) => apiPost<GroupRecord>('/groups', data),
  update: (id: string, data: { group_name?: string; description?: string | null }) =>
    apiPatch<GroupRecord>(`/groups/${id}`, data),
  remove: (id: string) => apiDelete<{ message: string }>(`/groups/${id}`),
  addMember: (id: string, memberId: string) => apiPost<{ message: string }>(`/groups/${id}/members/${memberId}`),
  removeMember: (id: string, memberId: string) => apiDelete<{ message: string }>(`/groups/${id}/members/${memberId}`),
};

export { groupsApi };
export type { GroupRecord };