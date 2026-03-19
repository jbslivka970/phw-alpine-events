import { BASE_URL, apiGet, apiPost } from './client';

interface ImportPreviewSummary {
  totalRows: number;
  newRows: number;
  updatedRows: number;
  unchangedRows: number;
  conflictRows: number;
  skippedRows: number;
  errorRows: number;
}

interface ImportCsvRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  mobilePhone: string;
  salutation: string;
  title: string;
  accountName: string;
  smsOptIn: boolean;
  emailOptOut: boolean;
}

interface ImportConflictMember {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string;
}

type ImportPreviewRowAction = 'new' | 'update' | 'unchanged' | 'conflict' | 'error';

interface ImportPreviewRow {
  rowNumber: number;
  action: ImportPreviewRowAction;
  data: ImportCsvRow;
  existingMemberId?: string;
  conflictMembers?: ImportConflictMember[];
  errorMessage?: string;
}

interface ImportPreviewResult {
  sessionId: string;
  fileName: string;
  summary: ImportPreviewSummary;
  rows: ImportPreviewRow[];
}

interface ImportCommitResult {
  importId: string;
  summary: ImportPreviewSummary;
  rowErrors?: Array<{ rowNumber: number; errorMessage: string }>;
}

interface ImportCommitRequest {
  conflictResolutions?: Record<string, 'create' | 'skip'>;
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
  commit: (sessionId: string, body?: ImportCommitRequest) =>
    apiPost<ImportCommitResult>(`/import/commit/${sessionId}`, body),
  logs: () => apiGet<{ logs: unknown[] }>('/import/logs'),
  logErrors: (importId: string) => apiGet<{ errors: unknown[] }>(`/import/logs/${importId}/errors`),
};

export { importApi };
export type {
  ImportCommitResult,
  ImportConflictMember,
  ImportPreviewResult,
  ImportPreviewRow,
  ImportPreviewSummary,
};