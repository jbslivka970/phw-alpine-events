import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import { getPool, sql } from '../db';
import { toE164 } from '../utils/phone';

interface CsvRow {
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

type RowAction = 'new' | 'update' | 'unchanged' | 'conflict' | 'error';

type ConflictResolution = 'create' | 'skip';

interface ExistingMemberConflict {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface PreviewRow {
  rowNumber: number;
  action: RowAction;
  data: CsvRow;
  existingMemberId?: string;
  conflictMembers?: ExistingMemberConflict[];
  errorMessage?: string;
}

interface ImportPreview {
  sessionId: string;
  fileName: string;
  totalRows: number;
  newRows: number;
  updatedRows: number;
  unchangedRows: number;
  conflictRows: number;
  skippedRows: number;
  errorRows: number;
  rows: PreviewRow[];
  createdAt: Date;
}

interface CommitResult {
  importId: string;
  committed: number;
  errors: number;
  rowErrors: Array<{ rowNumber: number; errorMessage: string }>;
  summary: {
    totalRows: number;
    newRows: number;
    updatedRows: number;
    unchangedRows: number;
    conflictRows: number;
    skippedRows: number;
    errorRows: number;
  };
}

interface ImportLogEntry {
  importId: string;
  fileName: string | null;
  rowsProcessed: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsErrored: number;
  status: string;
  errorDetail: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

interface ExistingMember {
  member_id: string;
  last_import_hash: string | null;
  first_name: string;
  last_name: string;
  email: string;
}

interface MatchOutcome {
  match: ExistingMember | null;
  sameEmailMembers?: ExistingMember[];
  conflictReason?: string;
}

interface CommitOptions {
  conflictResolutions?: Record<string, ConflictResolution>;
}

const sessions = new Map<string, { expiresAt: number; preview: ImportPreview }>();
const SESSION_TTL_MS = 30 * 60 * 1000;

const HEADER_MAP: Record<string, keyof Omit<CsvRow, 'rowNumber'>> = {
  firstname: 'firstName',
  'first name': 'firstName',
  lastname: 'lastName',
  'last name': 'lastName',
  email: 'email',
  'email address': 'email',
  mobile: 'mobilePhone',
  phone: 'mobilePhone',
  'mobile phone': 'mobilePhone',
  salutation: 'salutation',
  title: 'title',
  account: 'accountName',
  'account name': 'accountName',
  smsoptin: 'smsOptIn',
  'sms opt in': 'smsOptIn',
  emailoptout: 'emailOptOut',
  'email opt out': 'emailOptOut',
};

function normaliseHeader(raw: string): keyof Omit<CsvRow, 'rowNumber'> | null {
  const key = raw.trim().toLowerCase().replace(/[_-]/g, ' ');
  return HEADER_MAP[key] ?? null;
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, entry] of sessions.entries()) {
    if (entry.expiresAt < now) {
      sessions.delete(id);
    }
  }
}

function storePreviewSession(preview: ImportPreview): void {
  pruneSessions();
  sessions.set(preview.sessionId, {
    preview,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

function getPreviewSession(sessionId: string): ImportPreview | null {
  pruneSessions();
  const entry = sessions.get(sessionId);
  return entry?.preview ?? null;
}

function deletePreviewSession(sessionId: string): void {
  sessions.delete(sessionId);
}

function computeRowHash(row: CsvRow): string {
  const payload = [
    row.firstName,
    row.lastName,
    row.email,
    row.mobilePhone,
    row.salutation,
    row.title,
    row.accountName,
    row.smsOptIn ? '1' : '0',
    row.emailOptOut ? '1' : '0',
  ]
    .join('|')
    .toLowerCase();

  return crypto.createHash('sha256').update(payload).digest('hex');
}

function parseCsv(buffer: Buffer): CsvRow[] {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    bom: true,
  });

  return records.map((record, index) => {
    const mapped: Partial<Record<keyof Omit<CsvRow, 'rowNumber'>, string>> = {};

    for (const [header, value] of Object.entries(record)) {
      const canonical = normaliseHeader(header);
      if (canonical) {
        mapped[canonical] = value;
      }
    }

    const smsRaw = (mapped['smsOptIn'] ?? '').toLowerCase();
    const emailOptOutRaw = (mapped['emailOptOut'] ?? '').toLowerCase();

    return {
      rowNumber: index + 2,
      firstName: (mapped['firstName'] ?? '').trim(),
      lastName: (mapped['lastName'] ?? '').trim(),
      email: (mapped['email'] ?? '').trim().toLowerCase(),
      mobilePhone: toE164(mapped['mobilePhone'] ?? '') ?? '',
      salutation: (mapped['salutation'] ?? '').trim(),
      title: (mapped['title'] ?? '').trim(),
      accountName: (mapped['accountName'] ?? '').trim(),
      smsOptIn: smsRaw === '1' || smsRaw === 'true' || smsRaw === 'yes',
      emailOptOut: emailOptOutRaw === '1' || emailOptOutRaw === 'true' || emailOptOutRaw === 'yes',
    };
  });
}

async function findExistingMember(row: CsvRow): Promise<MatchOutcome> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('email', sql.NVarChar, row.email)
    .query<ExistingMember>(
      `SELECT member_id, last_import_hash, first_name, last_name, email
       FROM member
       WHERE LOWER(email) = @email`
    );

  const byEmail = result.recordset;
  const firstName = row.firstName.trim().toLowerCase();
  const lastName = row.lastName.trim().toLowerCase();
  const exactMatches = byEmail.filter(
    (member) => member.first_name.trim().toLowerCase() === firstName && member.last_name.trim().toLowerCase() === lastName
  );

  if (exactMatches.length > 1) {
    return {
      match: null,
      conflictReason: 'Multiple members with the same name/email combination exist. Resolve this household record manually before import.',
    };
  }

  if (exactMatches.length === 1) {
    return { match: exactMatches[0] };
  }

  if (byEmail.length > 0) {
    return {
      match: null,
      sameEmailMembers: byEmail,
      conflictReason: `Email already exists for ${byEmail.length} different member record(s). Shared-email households must be mapped by exact first/last name.`,
    };
  }

  return { match: null };
}

async function generatePreview(buffer: Buffer, fileName: string, sessionId: string): Promise<ImportPreview> {
  const rows = parseCsv(buffer);

  const previewRows: PreviewRow[] = [];
  let newRows = 0;
  let updatedRows = 0;
  let unchangedRows = 0;
  let conflictRows = 0;
  let errorRows = 0;

  for (const row of rows) {
    if (!row.email || !row.firstName || !row.lastName) {
      previewRows.push({
        rowNumber: row.rowNumber,
        action: 'error',
        data: row,
        errorMessage: 'firstName, lastName, and email are required.',
      });
      errorRows++;
      continue;
    }

    const { match: existing, conflictReason, sameEmailMembers } = await findExistingMember(row);

    if (conflictReason) {
      previewRows.push({
        rowNumber: row.rowNumber,
        action: 'conflict',
        data: row,
        conflictMembers: (sameEmailMembers ?? []).map((member) => ({
          memberId: member.member_id,
          firstName: member.first_name,
          lastName: member.last_name,
          email: member.email,
        })),
        errorMessage: conflictReason,
      });
      conflictRows++;
      continue;
    }

    const hash = computeRowHash(row);

    if (!existing) {
      previewRows.push({ rowNumber: row.rowNumber, action: 'new', data: row });
      newRows++;
      continue;
    }

    if (existing.last_import_hash === hash) {
      previewRows.push({
        rowNumber: row.rowNumber,
        action: 'unchanged',
        data: row,
        existingMemberId: existing.member_id,
      });
      unchangedRows++;
      continue;
    }

    previewRows.push({
      rowNumber: row.rowNumber,
      action: 'update',
      data: row,
      existingMemberId: existing.member_id,
    });
    updatedRows++;
  }

  return {
    sessionId,
    fileName,
    totalRows: rows.length,
    newRows,
    updatedRows,
    unchangedRows,
    conflictRows,
    skippedRows: 0,
    errorRows,
    rows: previewRows,
    createdAt: new Date(),
  };
}

async function commitImport(preview: ImportPreview, options?: CommitOptions): Promise<CommitResult> {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  const importId = crypto.randomUUID();
  const rowErrors: Array<{ rowNumber: number; errorMessage: string }> = [];
  const conflictResolutions = options?.conflictResolutions ?? {};
  let committed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('import_id', sql.UniqueIdentifier, importId)
      .input('file_name', sql.NVarChar, preview.fileName)
      .input('rows_processed', sql.Int, preview.totalRows)
      .input('rows_inserted', sql.Int, 0)
      .input('rows_updated', sql.Int, 0)
      .input('rows_skipped', sql.Int, preview.unchangedRows + preview.skippedRows)
      .input('rows_errored', sql.Int, preview.errorRows)
      .query(
        `INSERT INTO import_log
          (import_id, file_name, rows_processed, rows_inserted, rows_updated, rows_skipped, rows_errored, status, started_at)
         VALUES
          (@import_id, @file_name, @rows_processed, @rows_inserted, @rows_updated, @rows_skipped, @rows_errored, 'running', GETUTCDATE())`
      );

    for (const row of preview.rows) {
      if (row.action === 'error') {
        continue;
      }

      if (row.action === 'unchanged') {
        skipped++;
        continue;
      }

      if (row.action === 'conflict') {
        const resolution = conflictResolutions[String(row.rowNumber)];
        if (resolution === 'skip') {
          skipped++;
          continue;
        }

        if (resolution !== 'create') {
          rowErrors.push({
            rowNumber: row.rowNumber,
            errorMessage: 'Conflict row is missing a resolution. Choose create or skip before commit.',
          });
          continue;
        }
      }

      try {
        const hash = computeRowHash(row.data);

        if (row.action === 'new' || row.action === 'conflict') {
          await new sql.Request(tx)
            .input('member_id', sql.UniqueIdentifier, crypto.randomUUID())
            .input('first_name', sql.NVarChar, row.data.firstName)
            .input('last_name', sql.NVarChar, row.data.lastName)
            .input('email', sql.NVarChar, row.data.email)
            .input('mobile_phone', sql.NVarChar, row.data.mobilePhone || null)
            .input('sms_opt_in', sql.Bit, row.data.smsOptIn ? 1 : 0)
            .input('email_opt_out', sql.Bit, row.data.emailOptOut ? 1 : 0)
            .input('salutation', sql.NVarChar, row.data.salutation || null)
            .input('title', sql.NVarChar, row.data.title || null)
            .input('account_name', sql.NVarChar, row.data.accountName || null)
            .input('last_import_hash', sql.NVarChar, hash)
            .query(
              `INSERT INTO member
                (member_id, first_name, last_name, email, mobile_phone, sms_opt_in, email_opt_out, salutation, title, account_name, source, last_import_hash, is_active, created_at, updated_at)
               VALUES
                (@member_id, @first_name, @last_name, @email, @mobile_phone, @sms_opt_in, @email_opt_out, @salutation, @title, @account_name, 'import', @last_import_hash, 1, GETUTCDATE(), GETUTCDATE())`
            );
          inserted++;
          committed++;
          continue;
        }

        await new sql.Request(tx)
          .input('member_id', sql.UniqueIdentifier, row.existingMemberId)
          .input('first_name', sql.NVarChar, row.data.firstName)
          .input('last_name', sql.NVarChar, row.data.lastName)
          .input('email', sql.NVarChar, row.data.email)
          .input('mobile_phone', sql.NVarChar, row.data.mobilePhone || null)
          .input('sms_opt_in', sql.Bit, row.data.smsOptIn ? 1 : 0)
          .input('email_opt_out', sql.Bit, row.data.emailOptOut ? 1 : 0)
          .input('salutation', sql.NVarChar, row.data.salutation || null)
          .input('title', sql.NVarChar, row.data.title || null)
          .input('account_name', sql.NVarChar, row.data.accountName || null)
          .input('last_import_hash', sql.NVarChar, hash)
          .query(
            `UPDATE member SET
               first_name = @first_name,
               last_name = @last_name,
               email = @email,
               mobile_phone = @mobile_phone,
               sms_opt_in = @sms_opt_in,
               email_opt_out = @email_opt_out,
               salutation = @salutation,
               title = @title,
               account_name = @account_name,
               source = 'import',
               last_import_hash = @last_import_hash,
               updated_at = GETUTCDATE()
             WHERE member_id = @member_id`
          );
        updated++;
        committed++;
      } catch (error: unknown) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          errorMessage: error instanceof Error ? error.message : 'Row commit failed',
        });
      }
    }

    await new sql.Request(tx)
      .input('import_id', sql.UniqueIdentifier, importId)
      .input('rows_inserted', sql.Int, inserted)
      .input('rows_updated', sql.Int, updated)
      .input('rows_skipped', sql.Int, skipped)
      .input('rows_errored', sql.Int, preview.errorRows + rowErrors.length)
      .input('error_detail', sql.NVarChar(sql.MAX), rowErrors.length ? JSON.stringify(rowErrors) : null)
      .query(
        `UPDATE import_log SET
           rows_inserted = @rows_inserted,
           rows_updated = @rows_updated,
           rows_skipped = @rows_skipped,
           rows_errored = @rows_errored,
           error_detail = @error_detail,
           status = 'completed',
           completed_at = GETUTCDATE()
         WHERE import_id = @import_id`
      );

    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return {
    importId,
    committed,
    errors: preview.errorRows + rowErrors.length,
    rowErrors,
    summary: {
      totalRows: preview.totalRows,
      newRows: inserted,
      updatedRows: updated,
      unchangedRows: preview.unchangedRows,
      conflictRows: preview.conflictRows,
      skippedRows: skipped,
      errorRows: preview.errorRows + rowErrors.length,
    },
  };
}

async function getImportLogs(limit = 50): Promise<ImportLogEntry[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('limit', sql.Int, limit)
    .query<ImportLogEntry>(
      `SELECT TOP (@limit)
         import_id AS importId,
         file_name AS fileName,
         rows_processed AS rowsProcessed,
         rows_inserted AS rowsInserted,
         rows_updated AS rowsUpdated,
         rows_skipped AS rowsSkipped,
         rows_errored AS rowsErrored,
         status,
         error_detail AS errorDetail,
         started_at AS startedAt,
         completed_at AS completedAt
       FROM import_log
       ORDER BY started_at DESC`
    );

  return result.recordset;
}

async function getImportLogRowErrors(importId: string): Promise<Array<{ rowNumber: number; errorMessage: string }>> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('import_id', sql.UniqueIdentifier, importId)
    .query<{ error_detail: string | null }>('SELECT error_detail FROM import_log WHERE import_id = @import_id');

  const payload = result.recordset[0]?.error_detail;
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload) as Array<{ rowNumber: number; errorMessage: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export {
  commitImport,
  deletePreviewSession,
  generatePreview,
  getImportLogRowErrors,
  getImportLogs,
  getPreviewSession,
  storePreviewSession,
};
export type { CommitResult, CsvRow, ImportLogEntry, ImportPreview, PreviewRow };