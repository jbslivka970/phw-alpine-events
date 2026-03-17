import { apiGet, apiPost, apiPut, apiDelete } from './client';

export interface Group {
  id: number;
  name: string;
  description?: string;
  createdAt?: string;
}

export const groupsApi = {
  list: () => apiGet<Group[]>('/v1/groups'),
  get: (id: number) => apiGet<Group>(`/v1/groups/${id}`),
  create: (data: Omit<Group, 'id' | 'createdAt'>) => apiPost<Group>('/v1/groups', data),
  update: (id: number, data: Partial<Group>) => apiPut<Group>(`/v1/groups/${id}`, data),
  remove: (id: number) => apiDelete<void>(`/v1/groups/${id}`),
};
