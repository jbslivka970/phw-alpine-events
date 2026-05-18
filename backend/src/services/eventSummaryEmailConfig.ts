import { getPool } from '../db';

export interface EventSummaryEmailConfig {
  programLeadEmail: string | null;
  assistantProgramLeadEmails: string[];
}

export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export function normalizeEmailList(values: Array<string | null | undefined>): string[] {
  const emails = values
    .map((value) => normalizeEmail(value))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(emails));
}

export async function ensureEventSummaryEmailConfigTable(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.event_summary_email_config', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.event_summary_email_config (
        event_summary_email_config_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        program_lead_email NVARCHAR(255) NULL,
        assistant_program_lead_email_1 NVARCHAR(255) NULL,
        assistant_program_lead_email_2 NVARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
        updated_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
        updated_by NVARCHAR(255) NULL,
        CONSTRAINT PK_event_summary_email_config PRIMARY KEY (event_summary_email_config_id)
      );
    END
  `);
}

export async function loadEventSummaryEmailConfig(): Promise<EventSummaryEmailConfig> {
  await ensureEventSummaryEmailConfigTable();
  const pool = await getPool();
  const result = await pool
    .request()
    .query<{
      program_lead_email: string | null;
      assistant_program_lead_email_1: string | null;
      assistant_program_lead_email_2: string | null;
    }>(
      `SELECT TOP (1)
         program_lead_email,
         assistant_program_lead_email_1,
         assistant_program_lead_email_2
       FROM dbo.event_summary_email_config
       ORDER BY updated_at DESC`
    );

  const row = result.recordset[0];
  return {
    programLeadEmail: normalizeEmail(row?.program_lead_email),
    assistantProgramLeadEmails: normalizeEmailList([
      row?.assistant_program_lead_email_1,
      row?.assistant_program_lead_email_2,
    ]),
  };
}