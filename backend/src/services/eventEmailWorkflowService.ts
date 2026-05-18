import { randomUUID } from 'crypto';
import { getPool, sql } from '../db';
import { normalizeEmail } from './eventSummaryEmailConfig';

const PRE_EVENT_CLAIM_TIMEOUT_MINUTES = 30;

export interface EventEmailWorkflowSettings {
  schedulerEmail: string | null;
  creatorEmail: string | null;
  preEventAutoSentAt: string | null;
}

export interface ClaimedPreEventLeadSummary {
  eventId: string;
  claimToken: string;
}

export async function ensureEventEmailWorkflowTable(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.event_email_workflow', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.event_email_workflow (
        event_id UNIQUEIDENTIFIER NOT NULL,
        scheduler_email NVARCHAR(255) NULL,
        creator_email NVARCHAR(255) NULL,
        pre_event_auto_sent_at DATETIME NULL,
        pre_event_auto_claimed_at DATETIME NULL,
        pre_event_auto_claim_token UNIQUEIDENTIFIER NULL,
        created_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
        updated_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
        updated_by NVARCHAR(255) NULL,
        CONSTRAINT PK_event_email_workflow PRIMARY KEY (event_id),
        CONSTRAINT FK_event_email_workflow_event FOREIGN KEY (event_id)
          REFERENCES dbo.event (event_id) ON DELETE CASCADE
      );
    END
  `);
}

export async function getEventEmailWorkflowSettings(eventId: string): Promise<EventEmailWorkflowSettings> {
  await ensureEventEmailWorkflowTable();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<{
      scheduler_email: string | null;
      creator_email: string | null;
      pre_event_auto_sent_at: Date | null;
    }>(
      `SELECT scheduler_email, creator_email, pre_event_auto_sent_at
       FROM dbo.event_email_workflow
       WHERE event_id = @event_id`
    );

  const row = result.recordset[0];
  return {
    schedulerEmail: normalizeEmail(row?.scheduler_email),
    creatorEmail: normalizeEmail(row?.creator_email),
    preEventAutoSentAt: row?.pre_event_auto_sent_at ? row.pre_event_auto_sent_at.toISOString() : null,
  };
}

export async function upsertEventEmailWorkflowSettings(args: {
  eventId: string;
  schedulerEmail: string | null;
  creatorEmail: string | null;
  updatedBy: string;
}): Promise<void> {
  await ensureEventEmailWorkflowTable();
  const pool = await getPool();
  await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, args.eventId)
    .input('scheduler_email', sql.NVarChar(255), args.schedulerEmail)
    .input('creator_email', sql.NVarChar(255), args.creatorEmail)
    .input('updated_by', sql.NVarChar(255), args.updatedBy)
    .query(
      `IF EXISTS (SELECT 1 FROM dbo.event_email_workflow WHERE event_id = @event_id)
         BEGIN
           UPDATE dbo.event_email_workflow
           SET scheduler_email = @scheduler_email,
               creator_email = COALESCE(creator_email, @creator_email),
               updated_at = GETUTCDATE(),
               updated_by = @updated_by
           WHERE event_id = @event_id;
         END
       ELSE
         BEGIN
           INSERT INTO dbo.event_email_workflow (
             event_id,
             scheduler_email,
             creator_email,
             created_at,
             updated_at,
             updated_by
           )
           VALUES (
             @event_id,
             @scheduler_email,
             @creator_email,
             GETUTCDATE(),
             GETUTCDATE(),
             @updated_by
           );
         END`
    );
}

async function ensureWorkflowRowsForPublishedEvents(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(
    `INSERT INTO dbo.event_email_workflow (event_id, created_at, updated_at)
     SELECT e.event_id, GETUTCDATE(), GETUTCDATE()
     FROM dbo.event e
     LEFT JOIN dbo.event_email_workflow workflow ON workflow.event_id = e.event_id
     WHERE workflow.event_id IS NULL`
  );
}

export async function claimDuePreEventLeadSummaryEvents(lookAheadHours = 72): Promise<ClaimedPreEventLeadSummary[]> {
  await ensureEventEmailWorkflowTable();
  await ensureWorkflowRowsForPublishedEvents();

  const pool = await getPool();
  const claimToken = randomUUID();

  await pool
    .request()
    .input('lookAheadHours', sql.Int, lookAheadHours)
    .input('claimToken', sql.UniqueIdentifier, claimToken)
    .input('claimTimeoutMinutes', sql.Int, PRE_EVENT_CLAIM_TIMEOUT_MINUTES)
    .query(
      `UPDATE workflow
       SET workflow.pre_event_auto_claimed_at = GETUTCDATE(),
           workflow.pre_event_auto_claim_token = @claimToken
       FROM dbo.event_email_workflow workflow
       INNER JOIN dbo.event e ON e.event_id = workflow.event_id
       WHERE e.status = 'published'
         AND e.event_lead_email IS NOT NULL
         AND e.event_date > GETUTCDATE()
         AND e.event_date <= DATEADD(HOUR, @lookAheadHours, GETUTCDATE())
         AND workflow.pre_event_auto_sent_at IS NULL
         AND (
           workflow.pre_event_auto_claimed_at IS NULL
           OR workflow.pre_event_auto_claimed_at < DATEADD(MINUTE, -@claimTimeoutMinutes, GETUTCDATE())
         )`
    );

  const claimed = await pool
    .request()
    .input('claimToken', sql.UniqueIdentifier, claimToken)
    .query<{ event_id: string }>(
      `SELECT event_id
       FROM dbo.event_email_workflow
       WHERE pre_event_auto_claim_token = @claimToken`
    );

  return claimed.recordset.map((row) => ({
    eventId: row.event_id,
    claimToken,
  }));
}

export async function markPreEventLeadSummarySent(eventId: string, claimToken: string): Promise<void> {
  await ensureEventEmailWorkflowTable();
  const pool = await getPool();
  await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('claimToken', sql.UniqueIdentifier, claimToken)
    .query(
      `UPDATE dbo.event_email_workflow
       SET pre_event_auto_sent_at = GETUTCDATE(),
           pre_event_auto_claimed_at = NULL,
           pre_event_auto_claim_token = NULL,
           updated_at = GETUTCDATE()
       WHERE event_id = @event_id
         AND pre_event_auto_claim_token = @claimToken`
    );
}

export async function releasePreEventLeadSummaryClaim(eventId: string, claimToken: string): Promise<void> {
  await ensureEventEmailWorkflowTable();
  const pool = await getPool();
  await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('claimToken', sql.UniqueIdentifier, claimToken)
    .query(
      `UPDATE dbo.event_email_workflow
       SET pre_event_auto_claimed_at = NULL,
           pre_event_auto_claim_token = NULL,
           updated_at = GETUTCDATE()
       WHERE event_id = @event_id
         AND pre_event_auto_claim_token = @claimToken
         AND pre_event_auto_sent_at IS NULL`
    );
}