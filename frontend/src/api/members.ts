import { apiGet, apiPost, apiPut, apiDelete } from './client';

export interface Member {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  membershipStatus: string;
  createdAt?: string;
}

export const membersApi = {
  list: () => apiGet<Member[]>('/v1/members'),
  get: (id: number) => apiGet<Member>(`/v1/members/${id}`),
  create: (data: Omit<Member, 'id' | 'createdAt'>) => apiPost<Member>('/v1/members', data),
  update: (id: number, data: Partial<Member>) => apiPut<Member>(`/v1/members/${id}`, data),
  remove: (id: number) => apiDelete<void>(`/v1/members/${id}`),
};
