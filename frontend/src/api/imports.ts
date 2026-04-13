import { apiGet, apiGetBlob, apiPost, apiPostForm } from './client';

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
  activeVolunteer: boolean;
  activeParticipant: boolean;
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

interface ImportLog {
  importId: string;
  fileName: string | null;
  rowsProcessed: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsErrored: number;
  status: string;
  errorDetail: string | null;
  startedAt: string;
  completedAt: string | null;
  importedBy?: string | null;
}

interface ImportLogFilters {
  startedFrom?: string;
  startedTo?: string;
  importedBy?: string;
}

const importApi = {
  async preview(file: File): Promise<ImportPreviewResult> {
    const formData = new FormData();
    formData.append('file', file);

    try {
      return await apiPostForm<ImportPreviewResult>('/import/preview', formData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Import preview failed: ${message}`);
    }
  },
  commit: (sessionId: string, body?: ImportCommitRequest) =>
    apiPost<ImportCommitResult>(`/import/commit/${sessionId}`, body),
  logs: (filters?: ImportLogFilters) => {
    const query = new URLSearchParams();
    if (filters?.startedFrom) query.set('started_from', filters.startedFrom);
    if (filters?.startedTo) query.set('started_to', filters.startedTo);
    if (filters?.importedBy) query.set('imported_by', filters.importedBy);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return apiGet<{ logs: ImportLog[] }>(`/import/logs${suffix}`);
  },
  logErrors: (importId: string) => apiGet<{ errors: unknown[] }>(`/import/logs/${importId}/errors`),
  async downloadReport(importId: string): Promise<void> {
    const { blob, headers } = await apiGetBlob(`/import/logs/${importId}/report.csv`);
    const disposition = headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="?([^\";]+)"?/i);
    const fileName = match?.[1] || `import-${importId}-report.csv`;

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  },
};

export { importApi };
export type {
  ImportCommitResult,
  ImportLog,
  ImportLogFilters,
  ImportConflictMember,
  ImportPreviewResult,
  ImportPreviewRow,
  ImportPreviewSummary,
};