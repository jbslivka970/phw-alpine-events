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
  activeVolunteer: boolean;
  activeParticipant: boolean;
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
  absentMembers: AbsentMember[];
  createdAt: Date;
}

interface AbsentMember {
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
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
  importedByUserId?: string | null;
  importedByEmail?: string | null;
}

interface ImportLogFilters {
  startedFrom?: Date;
  startedTo?: Date;
  importedBy?: string;
}

interface ImportLogReport {
  fileName: string;
  csv: string;
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
  activevolunteer: 'activeVolunteer',
  'active volunteer': 'activeVolunteer',
  volunteerstatus: 'activeVolunteer',
  'volunteer status': 'activeVolunteer',
  activementor: 'activeVolunteer',
  'active mentor': 'activeVolunteer',
  activeparticipant: 'activeParticipant',
  'active participant': 'activeParticipant',
  participantstatus: 'activeParticipant',
  'participant status': 'activeParticipant',
};

function parseBooleanFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (['1', 'true', 'yes', 'y', 'active', 'enabled', 'current'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'inactive', 'disabled'].includes(normalized)) {
    return false;
  }

  return false;
}

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
    row.activeVolunteer ? '1' : '0',
    row.activeParticipant ? '1' : '0',
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

    const smsRaw = mapped['smsOptIn'];
    const emailOptOutRaw = mapped['emailOptOut'];
    const activeVolunteerRaw = mapped['activeVolunteer'];
    const activeParticipantRaw = mapped['activeParticipant'];

    return {
      rowNumber: index + 2,
      firstName: (mapped['firstName'] ?? '').trim(),
      lastName: (mapped['lastName'] ?? '').trim(),
      email: (mapped['email'] ?? '').trim().toLowerCase(),
      mobilePhone: toE164(mapped['mobilePhone'] ?? '') ?? '',
      salutation: (mapped['salutation'] ?? '').trim(),
      title: (mapped['title'] ?? '').trim(),
      accountName: (mapped['accountName'] ?? '').trim(),
      smsOptIn: parseBooleanFlag(smsRaw),
      emailOptOut: parseBooleanFlag(emailOptOutRaw),
      activeVolunteer: parseBooleanFlag(activeVolunteerRaw),
      activeParticipant: parseBooleanFlag(activeParticipantRaw),
    };
  });
}

function rowIdentitySignature(row: CsvRow): string {
  return [
    row.firstName.trim().toLowerCase(),
    row.lastName.trim().toLowerCase(),
    row.email.trim().toLowerCase(),
  ].join('|');
}

interface RoleGroupIds {
  volunteerGroupIds: string[];
  participantGroupIds: string[];
}

async function resolveRoleGroupIds(tx: sql.Transaction): Promise<RoleGroupIds> {
  const result = await new sql.Request(tx).query<{ group_id: string; group_name: string }>(
    `SELECT group_id, group_name
     FROM [group]
     WHERE UPPER(group_name) IN ('VOLUNTEERS', 'MENTORS', 'PARTICIPANTS')`
  );

  const volunteerGroupIds: string[] = [];
  const participantGroupIds: string[] = [];

  for (const row of result.recordset) {
    const groupName = row.group_name.trim().toUpperCase();
    if (groupName === 'VOLUNTEERS' || groupName === 'MENTORS') {
      volunteerGroupIds.push(row.group_id);
    }
    if (groupName === 'PARTICIPANTS') {
      participantGroupIds.push(row.group_id);
    }
  }

  return { volunteerGroupIds, participantGroupIds };
}

async function syncMemberRoleGroups(
  tx: sql.Transaction,
  memberId: string,
  row: CsvRow,
  roleGroups: RoleGroupIds
): Promise<void> {
  for (const groupId of roleGroups.volunteerGroupIds) {
    if (row.activeVolunteer) {
      await new sql.Request(tx)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .input('group_id', sql.UniqueIdentifier, groupId)
        .query(
          `IF NOT EXISTS (
             SELECT 1 FROM member_group
             WHERE member_id = @member_id AND group_id = @group_id
           )
           INSERT INTO member_group (member_group_id, member_id, group_id, added_at)
           VALUES (NEWID(), @member_id, @group_id, GETUTCDATE())`
        );
    } else {
      await new sql.Request(tx)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .input('group_id', sql.UniqueIdentifier, groupId)
        .query('DELETE FROM member_group WHERE member_id = @member_id AND group_id = @group_id');
    }
  }

  for (const groupId of roleGroups.participantGroupIds) {
    if (row.activeParticipant) {
      await new sql.Request(tx)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .input('group_id', sql.UniqueIdentifier, groupId)
        .query(
          `IF NOT EXISTS (
             SELECT 1 FROM member_group
             WHERE member_id = @member_id AND group_id = @group_id
           )
           INSERT INTO member_group (member_group_id, member_id, group_id, added_at)
           VALUES (NEWID(), @member_id, @group_id, GETUTCDATE())`
        );
    } else {
      await new sql.Request(tx)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .input('group_id', sql.UniqueIdentifier, groupId)
        .query('DELETE FROM member_group WHERE member_id = @member_id AND group_id = @group_id');
    }
  }
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
  const seenRowSignatures = new Map<string, number>();

  const previewRows: PreviewRow[] = [];
  let newRows = 0;
  let updatedRows = 0;
  let unchangedRows = 0;
  let conflictRows = 0;
  let skippedRows = 0;
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

    const signature = rowIdentitySignature(row);
    const existingRowNumber = seenRowSignatures.get(signature);
    if (existingRowNumber) {
      previewRows.push({
        rowNumber: row.rowNumber,
        action: 'unchanged',
        data: row,
        errorMessage: `Duplicate member row in CSV (matches row ${existingRowNumber} by firstName+lastName+email). Keeping the first row and skipping this duplicate.`,
      });
      skippedRows++;
      continue;
    }
    seenRowSignatures.set(signature, row.rowNumber);

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

  // Find active members in DB whose email is not present in the CSV
  const csvEmailSet = new Set(rows.map((r) => r.email.toLowerCase().trim()).filter(Boolean));
  let absentMembers: AbsentMember[] = [];
  try {
    const pool = await getPool();
    const allActiveResult = await pool
      .request()
      .query<AbsentMember>(
        `SELECT member_id, first_name, last_name, email
         FROM dbo.member
         WHERE is_active = 1`
      );
    absentMembers = allActiveResult.recordset.filter(
      (m) => !csvEmailSet.has(m.email.toLowerCase().trim())
    );
  } catch {
    // non-fatal — absent list stays empty on DB error
  }

  return {
    sessionId,
    fileName,
    totalRows: rows.length,
    newRows,
    updatedRows,
    unchangedRows,
    conflictRows,
    skippedRows,
    errorRows,
    rows: previewRows,
    absentMembers,
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
    const importedByUserId = await resolveImportedByUserId(
      tx,
      options?.importedByUserId ?? null,
      options?.importedByEmail ?? null
    );

    await new sql.Request(tx)
      .input('import_id', sql.UniqueIdentifier, importId)
      .input('imported_by', sql.UniqueIdentifier, importedByUserId)
      .input('file_name', sql.NVarChar, preview.fileName)
      .input('rows_processed', sql.Int, preview.totalRows)
      .input('rows_inserted', sql.Int, 0)
      .input('rows_updated', sql.Int, 0)
      .input('rows_skipped', sql.Int, preview.unchangedRows + preview.skippedRows)
      .input('rows_errored', sql.Int, preview.errorRows)
      .query(
        `INSERT INTO import_log
          (import_id, imported_by, file_name, rows_processed, rows_inserted, rows_updated, rows_skipped, rows_errored, status, started_at)
         VALUES
          (@import_id, @imported_by, @file_name, @rows_processed, @rows_inserted, @rows_updated, @rows_skipped, @rows_errored, 'running', GETUTCDATE())`
      );

    const roleGroups = await resolveRoleGroupIds(tx);

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
          const memberId = crypto.randomUUID();
          await new sql.Request(tx)
            .input('member_id', sql.UniqueIdentifier, memberId)
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
          await syncMemberRoleGroups(tx, memberId, row.data, roleGroups);
          inserted++;
          committed++;
          continue;
        }

        if (!row.existingMemberId) {
          throw new Error('existingMemberId is required for update rows.');
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
        await syncMemberRoleGroups(tx, row.existingMemberId, row.data, roleGroups);
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

async function getImportLogs(limit = 50, filters?: ImportLogFilters): Promise<ImportLogEntry[]> {
  const pool = await getPool();
  const request = pool.request().input('limit', sql.Int, limit);

  const whereClauses: string[] = [];
  if (filters?.startedFrom) {
    whereClauses.push('il.started_at >= @started_from');
    request.input('started_from', sql.DateTime, filters.startedFrom);
  }
  if (filters?.startedTo) {
    whereClauses.push('il.started_at < @started_to');
    request.input('started_to', sql.DateTime, filters.startedTo);
  }
  if (filters?.importedBy) {
    whereClauses.push('(u.email LIKE @imported_by OR il.imported_by = TRY_CONVERT(uniqueidentifier, @imported_by_exact))');
    request.input('imported_by', sql.NVarChar, `%${filters.importedBy}%`);
    request.input('imported_by_exact', sql.NVarChar, filters.importedBy);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const result = await request.query<ImportLogEntry>(
    `SELECT TOP (@limit)
       il.import_id AS importId,
       il.file_name AS fileName,
       il.rows_processed AS rowsProcessed,
       il.rows_inserted AS rowsInserted,
       il.rows_updated AS rowsUpdated,
       il.rows_skipped AS rowsSkipped,
       il.rows_errored AS rowsErrored,
       il.status,
       il.error_detail AS errorDetail,
       il.started_at AS startedAt,
       il.completed_at AS completedAt,
       COALESCE(u.email, CONVERT(nvarchar(36), il.imported_by)) AS importedBy
     FROM import_log il
     LEFT JOIN [user] u ON u.user_id = il.imported_by
     ${whereSql}
     ORDER BY il.started_at DESC`
  );

  return result.recordset;
}

async function getImportLogReport(importId: string): Promise<ImportLogReport | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('import_id', sql.UniqueIdentifier, importId)
    .query<{
      importId: string;
      fileName: string | null;
      rowsProcessed: number;
      rowsInserted: number;
      rowsUpdated: number;
      rowsSkipped: number;
      rowsErrored: number;
      status: string;
      startedAt: Date;
      completedAt: Date | null;
      importedBy: string | null;
      errorDetail: string | null;
    }>(
      `SELECT
         il.import_id AS importId,
         il.file_name AS fileName,
         il.rows_processed AS rowsProcessed,
         il.rows_inserted AS rowsInserted,
         il.rows_updated AS rowsUpdated,
         il.rows_skipped AS rowsSkipped,
         il.rows_errored AS rowsErrored,
         il.status,
         il.started_at AS startedAt,
         il.completed_at AS completedAt,
         COALESCE(u.email, CONVERT(nvarchar(36), il.imported_by)) AS importedBy,
         il.error_detail AS errorDetail
       FROM import_log il
       LEFT JOIN [user] u ON u.user_id = il.imported_by
       WHERE il.import_id = @import_id`
    );

  const row = result.recordset[0];
  if (!row) {
    return null;
  }

  const rowErrors = parseRowErrors(row.errorDetail);
  const lines: string[] = [];
  lines.push('section,key,value');
  lines.push(`summary,import_id,${csvCell(row.importId)}`);
  lines.push(`summary,file_name,${csvCell(row.fileName ?? '')}`);
  lines.push(`summary,status,${csvCell(row.status)}`);
  lines.push(`summary,started_at,${csvCell(new Date(row.startedAt).toISOString())}`);
  lines.push(`summary,completed_at,${csvCell(row.completedAt ? new Date(row.completedAt).toISOString() : '')}`);
  lines.push(`summary,imported_by,${csvCell(row.importedBy ?? '')}`);
  lines.push(`summary,rows_processed,${row.rowsProcessed}`);
  lines.push(`summary,rows_inserted,${row.rowsInserted}`);
  lines.push(`summary,rows_updated,${row.rowsUpdated}`);
  lines.push(`summary,rows_skipped,${row.rowsSkipped}`);
  lines.push(`summary,rows_errored,${row.rowsErrored}`);
  lines.push('');
  lines.push('section,row_number,error_message');

  for (const error of rowErrors) {
    lines.push(`row_error,${error.rowNumber},${csvCell(error.errorMessage)}`);
  }

  if (rowErrors.length === 0) {
    lines.push('row_error,,');
  }

  const reportName = (row.fileName ?? `import-${row.importId}`).replace(/\.csv$/i, '');
  return {
    fileName: `${reportName}-report.csv`,
    csv: lines.join('\n'),
  };
}

function parseRowErrors(payload: string | null): Array<{ rowNumber: number; errorMessage: string }> {
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload) as Array<{ rowNumber: number; errorMessage: string }>;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry) => typeof entry?.rowNumber === 'number' && typeof entry?.errorMessage === 'string'
    );
  } catch {
    return [];
  }
}

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function toNullableUuid(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const uuidV4Like = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Like.test(value) ? value : null;
}

async function resolveImportedByUserId(
  tx: InstanceType<typeof sql.Transaction>,
  userIdCandidate: string | null,
  emailCandidate: string | null
): Promise<string | null> {
  const normalizedUserId = toNullableUuid(userIdCandidate);
  if (normalizedUserId) {
    const byUserId = await new sql.Request(tx)
      .input('user_id', sql.UniqueIdentifier, normalizedUserId)
      .query<{ user_id: string }>('SELECT user_id FROM [user] WHERE user_id = @user_id');

    if (byUserId.recordset[0]?.user_id) {
      return byUserId.recordset[0].user_id;
    }
  }

  const normalizedEmail = (emailCandidate ?? '').trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const byEmail = await new sql.Request(tx)
    .input('email', sql.NVarChar(320), normalizedEmail)
    .query<{ user_id: string }>(
      `SELECT TOP 1 user_id
       FROM [user]
       WHERE LOWER(email) = @email
       ORDER BY is_active DESC, updated_at DESC`
    );

  return byEmail.recordset[0]?.user_id ?? null;
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
  getImportLogReport,
  getPreviewSession,
  storePreviewSession,
};
export type { CommitResult, CsvRow, ImportLogEntry, ImportLogFilters, ImportPreview, PreviewRow };