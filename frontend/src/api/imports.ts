import { BASE_URL, apiGet, apiPost } from './client';

interface ImportPreviewSummary {
  totalRows: number;
  newRows: number;
  updatedRows: number;
  unchangedRows: number;
  skippedRows: number;
  errorRows: number;
}

interface ImportPreviewResult {
  sessionId: string;
  fileName: string;
  summary: ImportPreviewSummary;
  rows: unknown[];
}

interface ImportCommitResult {
  importId: string;
  summary: ImportPreviewSummary;
}

const importApi = {
  async preview(file: File): Promise<ImportPreviewResult> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${BASE_URL}/import/preview`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new Error(`Import preview failed (${response.status}): ${message}`);
    }

    return (await response.json()) as ImportPreviewResult;
  },
  commit: (sessionId: string) => apiPost<ImportCommitResult>(`/import/commit/${sessionId}`),
  logs: () => apiGet<{ logs: unknown[] }>('/import/logs'),
  logErrors: (importId: string) => apiGet<{ errors: unknown[] }>(`/import/logs/${importId}/errors`),
};

export { importApi };
export type { ImportCommitResult, ImportPreviewResult, ImportPreviewSummary };