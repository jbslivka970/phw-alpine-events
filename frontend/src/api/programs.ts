import { apiGet } from './client';

interface ProgramCatalogRecord {
  program_id: string;
  program_name: string;
  state_name: string;
  sort_order: number;
  is_active: boolean;
}

const programsApi = {
  list: (params?: { state?: string }) => {
    const query = new URLSearchParams();
    if (params?.state) {
      query.set('state', params.state);
    }
    const suffix = query.toString();
    return apiGet<ProgramCatalogRecord[]>(suffix ? `/programs?${suffix}` : '/programs');
  },
};

export { programsApi };
export type { ProgramCatalogRecord };
