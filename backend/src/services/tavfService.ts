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
            tenant_id       UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tenant(tenant_id),
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
            CREATE INDEX idx_tavf_posting_tenant_status_date ON dbo.tavf_posting(tenant_id, status, event_date);
      END;

      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_application')
      BEGIN
          CREATE TABLE dbo.tavf_application (
              application_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
            tenant_id      UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tenant(tenant_id),
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
            CREATE INDEX idx_tavf_application_tenant_status ON dbo.tavf_application(tenant_id, status, applied_at);
      END;

      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_match')
      BEGIN
          CREATE TABLE dbo.tavf_match (
              match_id       UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
            tenant_id      UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tenant(tenant_id),
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
          CREATE INDEX idx_tavf_match_tenant_status ON dbo.tavf_match(tenant_id, status, matched_at);
      END;

      IF COL_LENGTH('dbo.tavf_posting', 'tenant_id') IS NULL
        ALTER TABLE dbo.tavf_posting ADD tenant_id UNIQUEIDENTIFIER NULL;

      IF COL_LENGTH('dbo.tavf_application', 'tenant_id') IS NULL
        ALTER TABLE dbo.tavf_application ADD tenant_id UNIQUEIDENTIFIER NULL;

      IF COL_LENGTH('dbo.tavf_match', 'tenant_id') IS NULL
        ALTER TABLE dbo.tavf_match ADD tenant_id UNIQUEIDENTIFIER NULL;

      DECLARE @default_tenant_id UNIQUEIDENTIFIER;
      SELECT TOP (1) @default_tenant_id = t.tenant_id
      FROM dbo.tenant t
      WHERE t.slug = N'colorado-alpine';

      IF @default_tenant_id IS NULL
        SELECT TOP (1) @default_tenant_id = t.tenant_id
        FROM dbo.tenant t
        WHERE t.status = N'active'
        ORDER BY t.created_at ASC;

      IF @default_tenant_id IS NOT NULL
      BEGIN
        UPDATE p
        SET p.tenant_id = COALESCE(tm.tenant_id, @default_tenant_id)
        FROM dbo.tavf_posting p
        OUTER APPLY (
          SELECT TOP (1) tm.tenant_id
          FROM dbo.tenant_membership tm
          WHERE tm.member_id = p.guide_member_id
            AND tm.status = N'active'
            AND tm.revoked_at IS NULL
          ORDER BY CASE WHEN tm.membership_kind = N'home' THEN 0 ELSE 1 END, tm.created_at ASC
        ) tm
        WHERE p.tenant_id IS NULL;

        UPDATE a
        SET a.tenant_id = COALESCE(p.tenant_id, @default_tenant_id)
        FROM dbo.tavf_application a
        INNER JOIN dbo.tavf_posting p ON p.posting_id = a.posting_id
        WHERE a.tenant_id IS NULL;

        UPDATE tm
        SET tm.tenant_id = COALESCE(p.tenant_id, @default_tenant_id)
        FROM dbo.tavf_match tm
        INNER JOIN dbo.tavf_posting p ON p.posting_id = tm.posting_id
        WHERE tm.tenant_id IS NULL;
      END;

      IF EXISTS (SELECT 1 FROM dbo.tavf_posting WHERE tenant_id IS NULL)
        THROW 51000, 'Unable to backfill tavf_posting.tenant_id for all records.', 1;

      IF EXISTS (SELECT 1 FROM dbo.tavf_application WHERE tenant_id IS NULL)
        THROW 51000, 'Unable to backfill tavf_application.tenant_id for all records.', 1;

      IF EXISTS (SELECT 1 FROM dbo.tavf_match WHERE tenant_id IS NULL)
        THROW 51000, 'Unable to backfill tavf_match.tenant_id for all records.', 1;

      IF EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.tavf_posting')
          AND name = N'tenant_id'
          AND is_nullable = 1
      )
        ALTER TABLE dbo.tavf_posting ALTER COLUMN tenant_id UNIQUEIDENTIFIER NOT NULL;

      IF EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.tavf_application')
          AND name = N'tenant_id'
          AND is_nullable = 1
      )
        ALTER TABLE dbo.tavf_application ALTER COLUMN tenant_id UNIQUEIDENTIFIER NOT NULL;

      IF EXISTS (
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.tavf_match')
          AND name = N'tenant_id'
          AND is_nullable = 1
      )
        ALTER TABLE dbo.tavf_match ALTER COLUMN tenant_id UNIQUEIDENTIFIER NOT NULL;

      IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys
        WHERE name = N'FK_tavf_posting_tenant'
          AND parent_object_id = OBJECT_ID(N'dbo.tavf_posting')
      )
        ALTER TABLE dbo.tavf_posting
          ADD CONSTRAINT FK_tavf_posting_tenant FOREIGN KEY (tenant_id)
          REFERENCES dbo.tenant(tenant_id);

      IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys
        WHERE name = N'FK_tavf_application_tenant'
          AND parent_object_id = OBJECT_ID(N'dbo.tavf_application')
      )
        ALTER TABLE dbo.tavf_application
          ADD CONSTRAINT FK_tavf_application_tenant FOREIGN KEY (tenant_id)
          REFERENCES dbo.tenant(tenant_id);

      IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys
        WHERE name = N'FK_tavf_match_tenant'
          AND parent_object_id = OBJECT_ID(N'dbo.tavf_match')
      )
        ALTER TABLE dbo.tavf_match
          ADD CONSTRAINT FK_tavf_match_tenant FOREIGN KEY (tenant_id)
          REFERENCES dbo.tenant(tenant_id);

      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name = N'idx_tavf_posting_tenant_status_date'
          AND object_id = OBJECT_ID(N'dbo.tavf_posting')
      )
        CREATE INDEX idx_tavf_posting_tenant_status_date ON dbo.tavf_posting(tenant_id, status, event_date);

      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name = N'idx_tavf_application_tenant_status'
          AND object_id = OBJECT_ID(N'dbo.tavf_application')
      )
        CREATE INDEX idx_tavf_application_tenant_status ON dbo.tavf_application(tenant_id, status, applied_at);

      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name = N'idx_tavf_match_tenant_status'
          AND object_id = OBJECT_ID(N'dbo.tavf_match')
      )
        CREATE INDEX idx_tavf_match_tenant_status ON dbo.tavf_match(tenant_id, status, matched_at);

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
  tenant_id: string;
  guide_member_id: string;
  guide_first_name?: string | null;
  guide_last_name?: string | null;
  guide_email?: string | null;
  guide_mobile_phone?: string | null;
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
  tenant_id: string;
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
  tenant_id: string;
  posting_id: string;
  vet_member_id: string;
  first_name?: string | null;
  last_name?: string | null;
  notes?: string | null;
  status: ApplicationStatus;
  applied_at: string;
  updated_at: string;
}

export interface CreateApplicationInput {
  tenant_id?: string;
  posting_id: string;
  vet_member_id: string;
  notes?: string;
}

export interface TavfMatch {
  match_id: string;
  tenant_id: string;
  posting_id: string;
  application_id: string;
  matched_by?: string | null;
  matched_at: string;
  status: MatchStatus;
  notes?: string | null;
}

export interface CreateMatchInput {
  tenant_id?: string;
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

async function autoClosePastOpenPostings(): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .query(
      `UPDATE tavf_posting
       SET status = 'cancelled',
           updated_at = GETDATE()
       WHERE status = 'open'
         AND event_date < CAST(GETUTCDATE() AS DATE)`
    );
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export async function listPostings(
  filters: { status?: PostingStatus; limit?: number; tenantId?: string } = {}
): Promise<TavfPosting[]> {
  await ensureTavfSchema();
  await autoClosePastOpenPostings();
  const pool = await getPool();
  const req = pool.request();
  let query = `SELECT
      p.*,
      guide.first_name AS guide_first_name,
      guide.last_name AS guide_last_name,
      guide.email AS guide_email,
      guide.mobile_phone AS guide_mobile_phone
    FROM tavf_posting p
    LEFT JOIN member guide ON guide.member_id = p.guide_member_id`;
  const whereClauses: string[] = [];
  if (filters.status) {
    req.input('status', sql.NVarChar(20), filters.status);
    whereClauses.push('p.status = @status');
  }
  if (filters.tenantId) {
    req.input('tenant_id', sql.UniqueIdentifier, filters.tenantId);
    whereClauses.push('p.tenant_id = @tenant_id');
  }
  if (whereClauses.length > 0) {
    query += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  query += ` ORDER BY p.event_date ASC`;
  if (typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0) {
    req.input('limit', sql.Int, Math.floor(filters.limit));
    query += ` OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`;
  }
  const result = await req.query<TavfPosting>(query);
  return result.recordset;
}

export async function getPosting(postingId: string): Promise<TavfPosting | null> {
  await ensureTavfSchema();
  await autoClosePastOpenPostings();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query<TavfPosting>(
      `SELECT
          p.*,
          guide.first_name AS guide_first_name,
          guide.last_name AS guide_last_name,
          guide.email AS guide_email,
          guide.mobile_phone AS guide_mobile_phone
       FROM tavf_posting p
       LEFT JOIN member guide ON guide.member_id = p.guide_member_id
       WHERE p.posting_id = @posting_id`
    );
  return result.recordset[0] ?? null;
}

export async function createPosting(input: CreatePostingInput): Promise<TavfPosting> {
  await ensureTavfSchema();
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, input.tenant_id)
    .input('guide_member_id', sql.UniqueIdentifier, input.guide_member_id)
    .input('event_date', sql.Date, input.event_date)
    .input('location', sql.NVarChar(500), input.location)
    .input('capacity', sql.Int, input.capacity)
    .input('species', sql.NVarChar(200), input.species ?? null)
    .input('description', sql.NVarChar(2000), input.description ?? null)
    .query<TavfPosting>(`
      INSERT INTO tavf_posting
        (tenant_id, guide_member_id, event_date, location, capacity, species, description)
      OUTPUT INSERTED.*
      VALUES
        (@tenant_id, @guide_member_id, @event_date, @location, @capacity, @species, @description)
    `);
  const posting = result.recordset[0];
  await notifications.notifyNewPosting(posting.posting_id);
  const detailed = await getPosting(posting.posting_id);
  return detailed ?? posting;
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
  const updated = result.recordset[0] ?? null;
  if (!updated) {
    return null;
  }

  const detailed = await getPosting(updated.posting_id);
  return detailed ?? updated;
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
      `SELECT
          ta.*, 
          m.first_name,
          m.last_name
       FROM tavf_application ta
       INNER JOIN member m ON m.member_id = ta.vet_member_id
       WHERE ta.posting_id = @posting_id
       ORDER BY ta.applied_at ASC`
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
      `SELECT
          ta.*, 
          m.first_name,
          m.last_name
       FROM tavf_application ta
       INNER JOIN member m ON m.member_id = ta.vet_member_id
       WHERE ta.application_id = @application_id`
    );
  return result.recordset[0] ?? null;
}

export async function createApplication(
  input: CreateApplicationInput
): Promise<TavfApplication> {
  await ensureTavfSchema();
  await autoClosePastOpenPostings();
  const pool = await getPool();

  const postingResult = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .query<{ posting_id: string }>(
      `SELECT posting_id
       FROM tavf_posting
       WHERE posting_id = @posting_id
         AND status = 'open'
         AND event_date >= CAST(GETUTCDATE() AS DATE)`
    );

  const posting = postingResult.recordset[0];
  if (!posting) {
    throw new Error('This posting is closed and no longer accepting applications.');
  }

  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, input.tenant_id ?? null)
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .input('vet_member_id', sql.UniqueIdentifier, input.vet_member_id)
    .input('notes', sql.NVarChar(1000), input.notes ?? null)
    .query<TavfApplication>(`
      INSERT INTO tavf_application (tenant_id, posting_id, vet_member_id, notes)
      OUTPUT INSERTED.*
      VALUES (COALESCE(@tenant_id, (SELECT TOP 1 tenant_id FROM tavf_posting WHERE posting_id = @posting_id)), @posting_id, @vet_member_id, @notes)
    `);
  const insertedApplicationId = result.recordset[0]?.application_id;
  if (!insertedApplicationId) {
    throw new Error('Failed to create TAVF application.');
  }

  const application = await getApplication(insertedApplicationId);
  if (!application) {
    throw new Error('Failed to load created TAVF application.');
  }

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
      WHERE application_id = @application_id
    `);

  if ((result.rowsAffected[0] ?? 0) === 0) {
    return null;
  }

  return getApplication(applicationId);
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
    .query<{ posting_id: string; tenant_id: string; location: string; event_date: Date }>(
      `SELECT posting_id, tenant_id, location, event_date
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
    .input('tenant_id', sql.UniqueIdentifier, input.tenant_id ?? posting.tenant_id)
    .input('posting_id', sql.UniqueIdentifier, input.posting_id)
    .input('application_id', sql.UniqueIdentifier, input.application_id)
    .input('matched_by', sql.UniqueIdentifier, matchedByMemberId)
    .input('notes', sql.NVarChar(1000), input.notes ?? null)
    .query<TavfMatch>(`
      INSERT INTO tavf_match (tenant_id, posting_id, application_id, matched_by, notes)
      OUTPUT INSERTED.*
      VALUES (@tenant_id, @posting_id, @application_id, @matched_by, @notes)
    `);
  const match = matchResult.recordset[0];

  // Mark the application as matched
  await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, input.tenant_id ?? posting.tenant_id)
    .input('application_id', sql.UniqueIdentifier, input.application_id)
    .query(`
      UPDATE tavf_application
      SET status = 'matched', updated_at = GETDATE()
      WHERE application_id = @application_id
        AND tenant_id = @tenant_id
    `);

  // If confirmed matches >= capacity, mark posting as filled
  await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, input.tenant_id ?? posting.tenant_id)
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
        AND tenant_id = @tenant_id
    `);

  // Auto-create corresponding event for the confirmed match.
  await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, input.tenant_id ?? posting.tenant_id)
    .input('title', sql.NVarChar(200), `Take a Vet Fishing — ${posting.location}`)
    .input('event_date', sql.DateTime, posting.event_date)
    .input('location', sql.NVarChar(300), posting.location)
    .input('capacity', sql.Int, 2)
    .input('created_by', sql.UniqueIdentifier, null)
    .query(
      `IF COL_LENGTH('dbo.event', 'tenant_id') IS NOT NULL
       BEGIN
         INSERT INTO event
           (event_id, tenant_id, title, event_date, location, capacity, status, created_by, created_at, updated_at)
         VALUES
           (NEWID(), @tenant_id, @title, @event_date, @location, @capacity, 'published', @created_by, GETUTCDATE(), GETUTCDATE())
       END
       ELSE
       BEGIN
         INSERT INTO event
           (event_id, title, event_date, location, capacity, status, created_by, created_at, updated_at)
         VALUES
           (NEWID(), @title, @event_date, @location, @capacity, 'published', @created_by, GETUTCDATE(), GETUTCDATE())
       END`
    );

  await notifications.notifyMatchConfirmed(match.match_id);

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
