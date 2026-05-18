import { getPool } from '../db';

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