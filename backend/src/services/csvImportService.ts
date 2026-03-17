import { parse } from 'csv-parse/sync';
import * as crypto from 'crypto';
import { getPool, sql } from '../db';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface CsvRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  mobilePhone: string;
  salutation: string;
  title: string;
  accountName: string;
  participantStatus: string;
  volunteerStatus: string;
  smsOptIn: boolean;
}

export type RowAction = 'new' | 'update' | 'unchanged' | 'skipped_manual' | 'error';

export interface PreviewRow {
  rowNumber: number;
  action: RowAction;
  sharedEmail: boolean;
  data: CsvRow;
  existingMemberId?: string;
  errorMessage?: string;
  changedFields?: string[];
}

export interface ImportPreview {
  sessionId: string;
  fileName: string;
  totalRows: number;
  newRows: number;
  updatedRows: number;
  unchangedRows: number;
  skippedRows: number;
  errorRows: number;
  sharedEmailCount: number;
  rows: PreviewRow[];
  createdAt: Date;
}

export interface CommitResult {
  importLogId: string;
  committed: number;
  errors: number;
  rowErrors: Array<{ rowNumber: number; errorMessage: string }>;
}

// ----------------------------------------------------------------
// In-memory preview session store (TTL: 30 min)
// ----------------------------------------------------------------

const SESSION_TTL_MS = 30 * 60 * 1000;

interface SessionEntry {
  preview: ImportPreview;
  expiresAt: Date;
}

const sessions = new Map<string, SessionEntry>();

function pruneExpiredSessions(): void {
  const now = new Date();
  for (const [id, entry] of sessions.entries()) {
    if (entry.expiresAt < now) {
      sessions.delete(id);
    }
  }
}

export function storePreviewSession(preview: ImportPreview): void {
  pruneExpiredSessions();
  sessions.set(preview.sessionId, {
    preview,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
}

export function getPreviewSession(sessionId: string): ImportPreview | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt < new Date()) {
    sessions.delete(sessionId);
    return null;
  }
  return entry.preview;
}

export function deletePreviewSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ----------------------------------------------------------------
// CSV column name normalisers
// ----------------------------------------------------------------

const HEADER_MAP: Record<string, keyof CsvRow | null> = {
  'first name': 'firstName',
  firstname: 'firstName',
  'last name': 'lastName',
  lastname: 'lastName',
  email: 'email',
  'email address': 'email',
  mobile: 'mobilePhone',
  'mobile phone': 'mobilePhone',
  'mobile phone number': 'mobilePhone',
  phone: 'mobilePhone',
  salutation: 'salutation',
  title: 'title',
  'account name': 'accountName',
  account: 'accountName',
  'participant status': 'participantStatus',
  'volunteer status': 'volunteerStatus',
  'sms opt in': 'smsOptIn',
  smsoptin: 'smsOptIn',
};

function normaliseHeader(raw: string): keyof CsvRow | null {
  const key = raw.trim().toLowerCase().replace(/[_-]/g, ' ');
  return HEADER_MAP[key] ?? null;
}

// ----------------------------------------------------------------
// Hash
// ----------------------------------------------------------------

export function computeRowHash(row: CsvRow): string {
  const payload = [
    row.firstName,
    row.lastName,
    row.email,
    row.mobilePhone,
    row.accountName,
    row.title,
    row.participantStatus,
    row.volunteerStatus,
    row.smsOptIn ? '1' : '0',
  ]
    .join('|')
    .toLowerCase();
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ----------------------------------------------------------------
// CSV parsing
// ----------------------------------------------------------------

export function parseCsvBuffer(buffer: Buffer): CsvRow[] {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  if (records.length === 0) {
    return [];
  }

  return records.map((record, idx) => {
    const norm: Partial<Record<keyof CsvRow, string>> = {};
    for (const [rawKey, value] of Object.entries(record)) {
      const canonical = normaliseHeader(rawKey);
      if (canonical) {
        norm[canonical] = value as string;
      }
    }

    const smsRaw = (norm['smsOptIn'] ?? '').toLowerCase();

    return {
      rowNumber: idx + 2, // 1-based, row 1 = header
      firstName: norm['firstName'] ?? '',
      lastName: norm['lastName'] ?? '',
      email: (norm['email'] ?? '').toLowerCase().trim(),
      mobilePhone: normalisePhone(norm['mobilePhone'] ?? ''),
      salutation: norm['salutation'] ?? '',
      title: norm['title'] ?? '',
      accountName: norm['accountName'] ?? '',
      participantStatus: norm['participantStatus'] ?? '',
      volunteerStatus: norm['volunteerStatus'] ?? '',
      smsOptIn: smsRaw === 'true' || smsRaw === '1' || smsRaw === 'yes',
    };
  });
}

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

// ----------------------------------------------------------------
// Preview generation
// ----------------------------------------------------------------

interface ExistingMember {
  member_id: string;
  email: string;
  last_import_hash: string | null;
  last_manual_edit: Date | null;
  last_import_date: Date | null;
}

export async function generatePreview(
  buffer: Buffer,
  fileName: string,
  sessionId: string,
): Promise<ImportPreview> {
  const rows = parseCsvBuffer(buffer);

  // Detect shared emails within the CSV
  const emailCount = new Map<string, number>();
  for (const row of rows) {
    if (row.email) {
      emailCount.set(row.email, (emailCount.get(row.email) ?? 0) + 1);
    }
  }

  // Fetch existing members by email
  const existingByEmail = await fetchExistingMembersByEmail(
    rows.map((r) => r.email).filter(Boolean),
  );

  const previewRows: PreviewRow[] = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let sharedEmailCount = 0;

  for (const row of rows) {
    const sharedEmail = (emailCount.get(row.email) ?? 0) > 1;
    if (sharedEmail) sharedEmailCount++;

    if (!row.email) {
      previewRows.push({
        rowNumber: row.rowNumber,
        action: 'error',
        sharedEmail: false,
        data: row,
        errorMessage: 'Email is required',
      });
      errorCount++;
      continue;
    }

    const existing = existingByEmail.get(row.email);
    const newHash = computeRowHash(row);

    if (!existing) {
      previewRows.push({
        rowNumber: row.rowNumber,
        action: 'new',
        sharedEmail,
        data: row,
      });
      newCount++;
    } else {
      // Manual-edit precedence: skip update if the record was manually edited
      // after the last import
      const lastImportDate = existing.last_import_date;
      const lastManualEdit = existing.last_manual_edit;
      if (
        lastManualEdit &&
        lastImportDate &&
        lastManualEdit > lastImportDate
      ) {
        previewRows.push({
          rowNumber: row.rowNumber,
          action: 'skipped_manual',
          sharedEmail,
          data: row,
          existingMemberId: existing.member_id,
        });
        skippedCount++;
        continue;
      }

      if (existing.last_import_hash === newHash) {
        previewRows.push({
          rowNumber: row.rowNumber,
          action: 'unchanged',
          sharedEmail,
          data: row,
          existingMemberId: existing.member_id,
        });
        unchangedCount++;
      } else {
        previewRows.push({
          rowNumber: row.rowNumber,
          action: 'update',
          sharedEmail,
          data: row,
          existingMemberId: existing.member_id,
          changedFields: detectChangedFields(row, existing),
        });
        updatedCount++;
      }
    }
  }

  const preview: ImportPreview = {
    sessionId,
    fileName,
    totalRows: rows.length,
    newRows: newCount,
    updatedRows: updatedCount,
    unchangedRows: unchangedCount,
    skippedRows: skippedCount,
    errorRows: errorCount,
    sharedEmailCount,
    rows: previewRows,
    createdAt: new Date(),
  };

  return preview;
}

// ----------------------------------------------------------------
// Commit
// ----------------------------------------------------------------

export async function commitImport(
  preview: ImportPreview,
  importedBy: string,
): Promise<CommitResult> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  const rowErrors: Array<{ rowNumber: number; errorMessage: string }> = [];
  let committed = 0;

  const participantsGroupId = await getOrCreateSystemGroup(pool, 'Participants');
  const volunteersGroupId = await getOrCreateSystemGroup(pool, 'Volunteers');

  const importLogId = generateUUID();
  const now = new Date();

  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input('importLogId', sql.UniqueIdentifier, importLogId)
      .input('fileName', sql.NVarChar(255), preview.fileName)
      .input('importedBy', sql.NVarChar(255), importedBy)
      .input('totalRows', sql.Int, preview.totalRows)
      .input('newRows', sql.Int, preview.newRows)
      .input('updatedRows', sql.Int, preview.updatedRows)
      .input('skippedRows', sql.Int, preview.skippedRows)
      .input('errorRows', sql.Int, preview.errorRows)
      .query(
        `INSERT INTO import_log
          (import_log_id, file_name, imported_by, total_rows, new_rows, updated_rows, skipped_rows, error_rows, status, created_at)
         VALUES
          (@importLogId, @fileName, @importedBy, @totalRows, @newRows, @updatedRows, @skippedRows, @errorRows, 'preview', GETDATE())`,
      );

    for (const row of preview.rows) {
      if (row.action === 'error') {
        await recordRowError(transaction, importLogId, row.rowNumber, row.data, row.errorMessage ?? 'Unknown error');
        continue;
      }
      if (row.action === 'unchanged' || row.action === 'skipped_manual') {
        continue;
      }

      try {
        const memberId = row.existingMemberId ?? generateUUID();
        const hash = computeRowHash(row.data);

        if (row.action === 'new') {
          await new sql.Request(transaction)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('firstName', sql.NVarChar(100), row.data.firstName)
            .input('lastName', sql.NVarChar(100), row.data.lastName)
            .input('email', sql.NVarChar(255), row.data.email)
            .input('mobilePhone', sql.NVarChar(20), row.data.mobilePhone || null)
            .input('smsOptIn', sql.Bit, row.data.smsOptIn ? 1 : 0)
            .input('salutation', sql.NVarChar(50), row.data.salutation || null)
            .input('title', sql.NVarChar(100), row.data.title || null)
            .input('accountName', sql.NVarChar(200), row.data.accountName || null)
            .input('participantStatus', sql.NVarChar(100), row.data.participantStatus || null)
            .input('volunteerStatus', sql.NVarChar(100), row.data.volunteerStatus || null)
            .input('hash', sql.NVarChar(64), hash)
            .query(
              `INSERT INTO member
                (member_id, first_name, last_name, email, mobile_phone, sms_opt_in, salutation, title,
                 account_name, participant_status, volunteer_status, source, last_import_hash, is_active, created_at, updated_at)
               VALUES
                (@memberId, @firstName, @lastName, @email, @mobilePhone, @smsOptIn, @salutation, @title,
                 @accountName, @participantStatus, @volunteerStatus, 'import', @hash, 1, GETDATE(), GETDATE())`,
            );
        } else if (row.action === 'update') {
          await new sql.Request(transaction)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('firstName', sql.NVarChar(100), row.data.firstName)
            .input('lastName', sql.NVarChar(100), row.data.lastName)
            .input('email', sql.NVarChar(255), row.data.email)
            .input('mobilePhone', sql.NVarChar(20), row.data.mobilePhone || null)
            .input('smsOptIn', sql.Bit, row.data.smsOptIn ? 1 : 0)
            .input('salutation', sql.NVarChar(50), row.data.salutation || null)
            .input('title', sql.NVarChar(100), row.data.title || null)
            .input('accountName', sql.NVarChar(200), row.data.accountName || null)
            .input('participantStatus', sql.NVarChar(100), row.data.participantStatus || null)
            .input('volunteerStatus', sql.NVarChar(100), row.data.volunteerStatus || null)
            .input('hash', sql.NVarChar(64), hash)
            .query(
              `UPDATE member SET
                first_name = @firstName, last_name = @lastName, email = @email,
                mobile_phone = @mobilePhone, sms_opt_in = @smsOptIn, salutation = @salutation,
                title = @title, account_name = @accountName, participant_status = @participantStatus,
                volunteer_status = @volunteerStatus, source = 'import', last_import_hash = @hash,
                updated_at = GETDATE()
               WHERE member_id = @memberId`,
            );
        }

        await assignMemberToGroups(
          transaction,
          memberId,
          row.data.participantStatus,
          row.data.volunteerStatus,
          participantsGroupId,
          volunteersGroupId,
        );

        committed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rowErrors.push({ rowNumber: row.rowNumber, errorMessage: msg });
        await recordRowError(transaction, importLogId, row.rowNumber, row.data, msg);
      }
    }

    await new sql.Request(transaction)
      .input('importLogId', sql.UniqueIdentifier, importLogId)
      .input('committedAt', sql.DateTime, now)
      .input('errorCount', sql.Int, rowErrors.length)
      .query(
        `UPDATE import_log SET status = 'committed', committed_at = @committedAt, error_rows = @errorCount
         WHERE import_log_id = @importLogId`,
      );

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    try {
      await pool
        .request()
        .input('importLogId', sql.UniqueIdentifier, importLogId)
        .query(`UPDATE import_log SET status = 'failed' WHERE import_log_id = @importLogId`);
    } catch (logErr) {
      console.error('Failed to mark import_log as failed:', logErr);
    }
    throw err;
  }

  return { importLogId, committed, errors: rowErrors.length, rowErrors };
}

// ----------------------------------------------------------------
// Import log history
// ----------------------------------------------------------------

export interface ImportLogEntry {
  importLogId: string;
  fileName: string;
  importedBy: string;
  totalRows: number;
  newRows: number;
  updatedRows: number;
  skippedRows: number;
  errorRows: number;
  status: string;
  createdAt: Date;
  committedAt: Date | null;
}

export async function getImportLogs(limit = 50): Promise<ImportLogEntry[]> {
  const pool = await getPool();
  const res = await pool
    .request()
    .input('limit', sql.Int, limit)
    .query(
      `SELECT TOP (@limit)
        import_log_id AS importLogId, file_name AS fileName, imported_by AS importedBy,
        total_rows AS totalRows, new_rows AS newRows, updated_rows AS updatedRows,
        skipped_rows AS skippedRows, error_rows AS errorRows, status,
        created_at AS createdAt, committed_at AS committedAt
       FROM import_log
       ORDER BY created_at DESC`,
    );
  return res.recordset;
}

export async function getImportLogRowErrors(
  importLogId: string,
): Promise<Array<{ rowNumber: number; rowData: string; errorMessage: string; createdAt: Date }>> {
  const pool = await getPool();
  const res = await pool
    .request()
    .input('importLogId', sql.UniqueIdentifier, importLogId)
    .query(
      `SELECT row_number AS rowNumber, row_data AS rowData, error_message AS errorMessage, created_at AS createdAt
       FROM import_row_error
       WHERE import_log_id = @importLogId
       ORDER BY row_number`,
    );
  return res.recordset;
}

// ----------------------------------------------------------------
// Private helpers
// ----------------------------------------------------------------

async function fetchExistingMembersByEmail(
  emails: string[],
): Promise<Map<string, ExistingMember>> {
  const result = new Map<string, ExistingMember>();
  if (emails.length === 0) return result;

  try {
    const pool = await getPool();
    const params = emails.map((_, i) => `@email${i}`).join(',');
    const req = pool.request();
    emails.forEach((e, i) => req.input(`email${i}`, sql.NVarChar(255), e));

    const res = await req.query(
      `SELECT m.member_id, m.email, m.last_import_hash, m.last_manual_edit,
              il.last_import_date
       FROM member m
       LEFT JOIN (
           SELECT MAX(committed_at) AS last_import_date
           FROM import_log
           WHERE status = 'committed'
       ) il ON 1=1
       WHERE m.email IN (${params}) AND m.is_active = 1`,
    );

    for (const row of res.recordset) {
      result.set((row.email as string).toLowerCase(), {
        member_id: row.member_id,
        email: row.email,
        last_import_hash: row.last_import_hash,
        last_manual_edit: row.last_manual_edit,
        last_import_date: row.last_import_date,
      });
    }
  } catch {
    // DB might not be available; return empty map so preview still works
  }
  return result;
}

async function getOrCreateSystemGroup(
  pool: sql.ConnectionPool,
  name: string,
): Promise<string> {
  const res = await pool
    .request()
    .input('name', sql.NVarChar(100), name)
    .query(`SELECT group_id FROM member_group WHERE group_name = @name`);

  if (res.recordset.length > 0) {
    return res.recordset[0].group_id as string;
  }

  const newId = generateUUID();
  await pool
    .request()
    .input('groupId', sql.UniqueIdentifier, newId)
    .input('name', sql.NVarChar(100), name)
    .query(
      `INSERT INTO member_group (group_id, group_name, is_system) VALUES (@groupId, @name, 1)`,
    );
  return newId;
}

async function assignMemberToGroups(
  transaction: sql.Transaction,
  memberId: string,
  participantStatus: string,
  volunteerStatus: string,
  participantsGroupId: string,
  volunteersGroupId: string,
): Promise<void> {
  if (participantStatus) {
    await upsertGroupMember(transaction, participantsGroupId, memberId);
  }
  if (volunteerStatus) {
    await upsertGroupMember(transaction, volunteersGroupId, memberId);
  }
}

async function upsertGroupMember(
  transaction: sql.Transaction,
  groupId: string,
  memberId: string,
): Promise<void> {
  await new sql.Request(transaction)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(
      `IF NOT EXISTS (
          SELECT 1 FROM group_member WHERE group_id = @groupId AND member_id = @memberId
       )
       INSERT INTO group_member (group_id, member_id) VALUES (@groupId, @memberId)`,
    );
}

async function recordRowError(
  transaction: sql.Transaction,
  importLogId: string,
  rowNumber: number,
  rowData: CsvRow,
  errorMessage: string,
): Promise<void> {
  try {
    await new sql.Request(transaction)
      .input('importLogId', sql.UniqueIdentifier, importLogId)
      .input('rowNumber', sql.Int, rowNumber)
      .input('rowData', sql.NVarChar(sql.MAX), JSON.stringify(rowData))
      .input('errorMessage', sql.NVarChar(500), errorMessage.substring(0, 500))
      .query(
        `INSERT INTO import_row_error (import_log_id, row_number, row_data, error_message)
         VALUES (@importLogId, @rowNumber, @rowData, @errorMessage)`,
      );
  } catch {
    // ignore
  }
}

function detectChangedFields(newRow: CsvRow, existing: ExistingMember): string[] {
  // We compare the fields we can access from the ExistingMember record.
  // Full field-level diff would require fetching all columns; for now we
  // report the hash changed to indicate "data" fields differ.
  const changed: string[] = [];
  if (existing.email.toLowerCase() !== newRow.email.toLowerCase()) {
    changed.push('email');
  }
  // Hash mismatch guarantees at least one field changed; ensure we always
  // return a non-empty list so the UI shows "data changed".
  if (changed.length === 0) {
    changed.push('data');
  }
  return changed;
}

function generateUUID(): string {
  return crypto.randomUUID();
}
