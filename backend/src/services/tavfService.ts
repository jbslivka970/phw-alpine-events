import sql from 'mssql';
import { getPool } from '../db';
import * as notifications from './notifications';

let tavfSchemaEnsurePromise: Promise<void> | null = null;

async function ensureTavfSchema(): Promise<void> {
  if (tavfSchemaEnsurePromise) {
    return tavfSchemaEnsurePromise;
  }

  tavfSchemaEnsurePromise = (async () => {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_posting')
      BEGIN
          CREATE TABLE dbo.tavf_posting (
              posting_id      UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
              guide_member_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.member(member_id),
              event_date      DATE NOT NULL,
              location        NVARCHAR(500) NOT NULL,
              capacity        INT NOT NULL DEFAULT 1,
              species         NVARCHAR(200),
              description     NVARCHAR(2000),
              status          NVARCHAR(20) NOT NULL DEFAULT 'open'
                                  CONSTRAINT chk_tavf_posting_status CHECK (status IN ('open', 'filled', 'cancelled')),
              created_at      DATETIME NOT NULL DEFAULT GETDATE(),
              updated_at      DATETIME NOT NULL DEFAULT GETDATE()
          );
          CREATE INDEX idx_tavf_posting_guide  ON dbo.tavf_posting(guide_member_id);
          CREATE INDEX idx_tavf_posting_date   ON dbo.tavf_posting(event_date);
          CREATE INDEX idx_tavf_posting_status ON dbo.tavf_posting(status);
      END;

      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_application')
      BEGIN
          CREATE TABLE dbo.tavf_application (
              application_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
              posting_id     UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tavf_posting(posting_id),
              vet_member_id  UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.member(member_id),
              notes          NVARCHAR(1000),
              status         NVARCHAR(20) NOT NULL DEFAULT 'pending'
                                 CONSTRAINT chk_tavf_application_status CHECK (status IN ('pending', 'matched', 'waitlisted', 'withdrawn')),
              applied_at     DATETIME NOT NULL DEFAULT GETDATE(),
              updated_at     DATETIME NOT NULL DEFAULT GETDATE(),
              CONSTRAINT uq_tavf_application UNIQUE (posting_id, vet_member_id)
          );
          CREATE INDEX idx_tavf_application_posting ON dbo.tavf_application(posting_id);
          CREATE INDEX idx_tavf_application_vet     ON dbo.tavf_application(vet_member_id);
      END;

      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_match')
      BEGIN
          CREATE TABLE dbo.tavf_match (
              match_id       UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
              posting_id     UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tavf_posting(posting_id),
              application_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tavf_application(application_id),
              matched_by     UNIQUEIDENTIFIER REFERENCES dbo.member(member_id),
              matched_at     DATETIME NOT NULL DEFAULT GETDATE(),
              status         NVARCHAR(20) NOT NULL DEFAULT 'confirmed'
                                 CONSTRAINT chk_tavf_match_status CHECK (status IN ('confirmed', 'cancelled')),
              notes          NVARCHAR(1000),
              CONSTRAINT uq_tavf_match UNIQUE (posting_id, application_id)
          );
          CREATE INDEX idx_tavf_match_posting     ON dbo.tavf_match(posting_id);
          CREATE INDEX idx_tavf_match_application ON dbo.tavf_match(application_id);
      END;

          IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_notification_subscription')
          BEGIN
            CREATE TABLE dbo.tavf_notification_subscription (
              member_id       UNIQUEIDENTIFIER NOT NULL PRIMARY KEY REFERENCES dbo.member(member_id),
              is_subscribed   BIT              NOT NULL DEFAULT 0,
              source          NVARCHAR(30)     NOT NULL DEFAULT 'preferences',
              updated_at      DATETIME         NOT NULL DEFAULT GETDATE()
            );
          END;
    `);
  })().catch((error) => {
    tavfSchemaEnsurePromise = null;
    throw error;
  });

  return tavfSchemaEnsurePromise;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PostingStatus = 'open' | 'filled' | 'cancelled';
export type ApplicationStatus = 'pending' | 'matched' | 'waitlisted' | 'withdrawn';
export type MatchStatus = 'confirmed' | 'cancelled';

export interface TavfPosting {
  posting_id: string;
  guide_member_id: string;
  event_date: string;
  location: string;
  capacity: number;
  species?: string | null;
  description?: string | null;
  status: PostingStatus;
  created_at: string;
  updated_at: string;
}

export interface CreatePostingInput {
  guide_member_id: string;
  event_date: string;   // ISO date YYYY-MM-DD
  location: string;
  capacity: number;
  species?: string;
  description?: string;
}

export interface UpdatePostingInput {
  event_date?: string;
  location?: string;
  capacity?: number;
  species?: string;
  description?: string;
  status?: PostingStatus;
}

export interface TavfApplication {
  application_id: string;
  posting_id: string;
  vet_member_id: string;
  notes?: string | null;
  status: ApplicationStatus;
  applied_at: string;
  updated_at: string;
}

export interface CreateApplicationInput {
  posting_id: string;
  vet_member_id: string;
  notes?: string;
}

export interface TavfMatch {
  match_id: string;
  posting_id: string;
  application_id: string;
  matched_by?: string | null;
  matched_at: string;
  status: MatchStatus;
  notes?: string | null;
}

export interface CreateMatchInput {
  posting_id: string;
  application_id: string;
  matched_by?: string;
  notes?: string;
}

export interface TavfNotificationSubscription {
  member_id: string;
  is_subscribed: boolean;
  source: string;
  updated_at: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export async function listPostings(
  filters: { status?: PostingStatus } = {}
): Promise<TavfPosting[]> {
  await ensureTavfSchema();
  const pool = await getPool();
  const req = pool.request();
  let query = `SELECT * FROM tavf_posting`;
  if (filters.status) {
    req.input('status', sql.NVarChar(20), filters.status);
    query += ` WHERE status = @status`;
  }
  query += ` ORDER BY event_date ASC`;
  const result = await req.query<TavfPosting>(query);
  return result.recordset;
}

export async function getPosting(postingId: string): Promise<TavfPosting | null> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query<TavfPosting>(`SELECT * FROM tavf_posting WHERE posting_id = @posting_id`);
  return result.recordset[0] ?? null;
}

export async function createPosting(input: CreatePostingInput): Promise<TavfPosting> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('guide_member_id', sql.UniqueIdentifier, input.guide_member_id)
    .input('event_date', sql.Date, input.event_date)
    .input('location', sql.NVarChar(500), input.location)
    .input('capacity', sql.Int, input.capacity)
    .input('species', sql.NVarChar(200), input.species ?? null)
    .input('description', sql.NVarChar(2000), input.description ?? null)
    .query<TavfPosting>(`
      INSERT INTO tavf_posting
        (guide_member_id, event_date, location, capacity, species, description)
      OUTPUT INSERTED.*
      VALUES
        (@guide_member_id, @event_date, @location, @capacity, @species, @description)
    `);
  const posting = result.recordset[0];

  await notifications.notifyNewPosting(posting.posting_id);

  return posting;
}

export async function updatePosting(
  postingId: string,
  input: UpdatePostingInput
): Promise<TavfPosting | null> {
  await ensureTavfSchema();
  const existing = await getPosting(postingId);
  if (!existing) return null;

  const pool = await getPool();
  const merged = {
    event_date: input.event_date ?? existing.event_date,
    location: input.location ?? existing.location,
    capacity: input.capacity ?? existing.capacity,
    species: input.species !== undefined ? input.species : existing.species,
    description: input.description !== undefined ? input.description : existing.description,
    status: input.status ?? existing.status,
  };

  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .input('event_date', sql.Date, merged.event_date)
    .input('location', sql.NVarChar(500), merged.location)
    .input('capacity', sql.Int, merged.capacity)
    .input('species', sql.NVarChar(200), merged.species ?? null)
    .input('description', sql.NVarChar(2000), merged.description ?? null)
    .input('status', sql.NVarChar(20), merged.status)
    .query<TavfPosting>(`
      UPDATE tavf_posting
      SET event_date   = @event_date,
          location     = @location,
          capacity     = @capacity,
          species      = @species,
          description  = @description,
          status       = @status,
          updated_at   = GETDATE()
      OUTPUT INSERTED.*
      WHERE posting_id = @posting_id
    `);
  return result.recordset[0] ?? null;
}

export async function deletePosting(postingId: string): Promise<boolean> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query(`DELETE FROM tavf_posting WHERE posting_id = @posting_id`);
  return (result.rowsAffected[0] ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export async function listApplicationsForPosting(
  postingId: string
): Promise<TavfApplication[]> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query<TavfApplication>(
      `SELECT * FROM tavf_application WHERE posting_id = @posting_id ORDER BY applied_at ASC`
    );
  return result.recordset;
}

export async function getApplication(applicationId: string): Promise<TavfApplication | null> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('application_id', sql.UniqueIdentifier, applicationId)
    .query<TavfApplication>(
      `SELECT * FROM tavf_application WHERE application_id = @application_id`
    );
  return result.recordset[0] ?? null;
}

export async function createApplication(
  input: CreateApplicationInput
): Promise<TavfApplication> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .input('vet_member_id', sql.UniqueIdentifier, input.vet_member_id)
    .input('notes', sql.NVarChar(1000), input.notes ?? null)
    .query<TavfApplication>(`
      INSERT INTO tavf_application (posting_id, vet_member_id, notes)
      OUTPUT INSERTED.*
      VALUES (@posting_id, @vet_member_id, @notes)
    `);
  const application = result.recordset[0];

  await notifications.notifyApplicationReceived(application.application_id);

  return application;
}

export async function updateApplicationStatus(
  applicationId: string,
  status: ApplicationStatus
): Promise<TavfApplication | null> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('application_id', sql.UniqueIdentifier, applicationId)
    .input('status', sql.NVarChar(20), status)
    .query<TavfApplication>(`
      UPDATE tavf_application
      SET status = @status, updated_at = GETDATE()
      OUTPUT INSERTED.*
      WHERE application_id = @application_id
    `);
  return result.recordset[0] ?? null;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export async function listMatchesForPosting(postingId: string): Promise<TavfMatch[]> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query<TavfMatch>(
      `SELECT * FROM tavf_match WHERE posting_id = @posting_id ORDER BY matched_at ASC`
    );
  return result.recordset;
}

export async function getMatch(matchId: string): Promise<TavfMatch | null> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .query<TavfMatch>(`SELECT * FROM tavf_match WHERE match_id = @match_id`);
  return result.recordset[0] ?? null;
}

/**
 * Create a confirmed match between a posting and an application.
 * Also marks the application status as 'matched' and recalculates
 * whether the posting is now 'filled'.
 */
export async function createMatch(input: CreateMatchInput): Promise<TavfMatch> {
  await ensureTavfSchema();
  const pool = await getPool();

  let matchedByMemberId: string | null = null;
  if (input.matched_by && isUuid(input.matched_by)) {
    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, input.matched_by)
      .query<{ member_id: string }>(`SELECT member_id FROM member WHERE member_id = @member_id`);

    if (memberResult.recordset.length > 0) {
      matchedByMemberId = input.matched_by;
    }
  }

  const postingResult = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .query<{ posting_id: string; location: string; event_date: Date }>(
      `SELECT posting_id, location, event_date
       FROM tavf_posting
       WHERE posting_id = @posting_id`
    );
  const posting = postingResult.recordset[0];
  if (!posting) {
    throw new Error('Posting not found for match creation.');
  }

  // Insert the match record
  const matchResult = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .input('application_id', sql.UniqueIdentifier, input.application_id)
    .input('matched_by', sql.UniqueIdentifier, matchedByMemberId)
    .input('notes', sql.NVarChar(1000), input.notes ?? null)
    .query<TavfMatch>(`
      INSERT INTO tavf_match (posting_id, application_id, matched_by, notes)
      OUTPUT INSERTED.*
      VALUES (@posting_id, @application_id, @matched_by, @notes)
    `);
  const match = matchResult.recordset[0];

  // Mark the application as matched
  await pool
    .request()
    .input('application_id', sql.UniqueIdentifier, input.application_id)
    .query(`
      UPDATE tavf_application
      SET status = 'matched', updated_at = GETDATE()
      WHERE application_id = @application_id
    `);

  // If confirmed matches >= capacity, mark posting as filled
  await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .query(`
      UPDATE tavf_posting
      SET status = CASE
            WHEN (
              SELECT COUNT(*) FROM tavf_match
              WHERE posting_id = @posting_id AND status = 'confirmed'
            ) >= capacity THEN 'filled'
            ELSE status
          END,
          updated_at = GETDATE()
      WHERE posting_id = @posting_id
    `);

  // Auto-create corresponding event for the confirmed match.
  await pool
    .request()
    .input('title', sql.NVarChar(200), `Take a Vet Fishing — ${posting.location}`)
    .input('event_date', sql.DateTime, posting.event_date)
    .input('location', sql.NVarChar(300), posting.location)
    .input('capacity', sql.Int, 2)
    .input('created_by', sql.UniqueIdentifier, null)
    .query(
      `INSERT INTO event
         (event_id, title, event_date, location, capacity, status, created_by, created_at, updated_at)
       VALUES
         (NEWID(), @title, @event_date, @location, @capacity, 'published', @created_by, GETUTCDATE(), GETUTCDATE())`
    );

  await notifications.notifyMatchConfirmed(match.match_id);

  // Auto-create an event for the matched posting
  try {
    const postingResult = await pool
      .request()
      .input('posting_id', sql.UniqueIdentifier, input.posting_id)
      .query<{ event_date: string; location: string; capacity: number }>(
        `SELECT event_date, location, capacity FROM tavf_posting WHERE posting_id = @posting_id`
      );
    const posting = postingResult.recordset[0];
    if (posting) {
      await pool
        .request()
        .input('title', sql.NVarChar(300), `Take a Vet Fishing — ${posting.location}`)
        .input('event_date', sql.DateTime, new Date(posting.event_date))
        .input('location', sql.NVarChar(500), posting.location)
        .input('capacity', sql.Int, 2)
        .query(`
          INSERT INTO event (title, event_date, location, capacity, status, description)
          VALUES (@title, @event_date, @location, @capacity, 'published',
                  'Auto-created from TAVF match')
        `);
    }
  } catch (eventErr) {
    console.error('[tavfService] Failed to auto-create event for match', eventErr);
  }

  return match;
}

export async function cancelMatch(matchId: string): Promise<TavfMatch | null> {
  await ensureTavfSchema();
  const pool = await getPool();

  // Get the match first to know posting/application IDs
  const existing = await getMatch(matchId);
  if (!existing) return null;

  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .query<TavfMatch>(`
      UPDATE tavf_match
      SET status = 'cancelled'
      OUTPUT INSERTED.*
      WHERE match_id = @match_id
    `);
  const updated = result.recordset[0];
  if (!updated) return null;

  // Revert application to pending
  await pool
    .request()
    .input('application_id', sql.UniqueIdentifier, existing.application_id)
    .query(`
      UPDATE tavf_application
      SET status = 'pending', updated_at = GETDATE()
      WHERE application_id = @application_id
    `);

  // Re-open posting if it was filled
  await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, existing.posting_id)
    .query(`
      UPDATE tavf_posting
      SET status = CASE WHEN status = 'filled' THEN 'open' ELSE status END,
          updated_at = GETDATE()
      WHERE posting_id = @posting_id
    `);

  await notifications.notifyMatchCancelled(matchId);

  return updated;
}

export async function getNotificationSubscription(memberId: string): Promise<TavfNotificationSubscription> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<TavfNotificationSubscription>(
      `SELECT member_id, is_subscribed, source, updated_at
       FROM tavf_notification_subscription
       WHERE member_id = @member_id`
    );

  const row = result.recordset[0];
  if (row) {
    return row;
  }

  return {
    member_id: memberId,
    is_subscribed: false,
    source: 'preferences',
    updated_at: new Date(0).toISOString(),
  };
}

export async function upsertNotificationSubscription(
  memberId: string,
  isSubscribed: boolean,
  source = 'preferences'
): Promise<TavfNotificationSubscription> {
  await ensureTavfSchema();
  const pool = await getPool();

  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('is_subscribed', sql.Bit, isSubscribed ? 1 : 0)
    .input('source', sql.NVarChar(30), source)
    .query<TavfNotificationSubscription>(
      `MERGE tavf_notification_subscription AS target
       USING (SELECT @member_id AS member_id) AS source
       ON target.member_id = source.member_id
       WHEN MATCHED THEN
         UPDATE SET is_subscribed = @is_subscribed, source = @source, updated_at = GETDATE()
       WHEN NOT MATCHED THEN
         INSERT (member_id, is_subscribed, source, updated_at)
         VALUES (@member_id, @is_subscribed, @source, GETDATE())
       OUTPUT INSERTED.member_id, INSERTED.is_subscribed, INSERTED.source, INSERTED.updated_at;`
    );

  return result.recordset[0] as TavfNotificationSubscription;
}
