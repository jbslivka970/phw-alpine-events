import { apiPost } from './client';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export const importApi = {
  uploadCsv: (formData: FormData) =>
    fetch(
      `${(import.meta.env.VITE_API_BASE_URL as string) || '/api'}/v1/import/members`,
      {
        method: 'POST',
        body: formData,
        // No Content-Type header – browser sets multipart boundary automatically
      }
    ).then(async (res) => {
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`Import API ${res.status}: ${msg}`);
      }
      return res.json() as Promise<ImportResult>;
    }),
  preview: (data: unknown) => apiPost<ImportResult>('/v1/import/preview', data),
};
