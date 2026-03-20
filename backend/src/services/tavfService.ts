import sql from 'mssql';
import { getPool } from '../db';
import * as notifications from './notifications';

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

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export async function listPostings(
  filters: { status?: PostingStatus } = {}
): Promise<TavfPosting[]> {
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
  const pool = await getPool();
  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query<TavfPosting>(`SELECT * FROM tavf_posting WHERE posting_id = @posting_id`);
  return result.recordset[0] ?? null;
}

export async function createPosting(input: CreatePostingInput): Promise<TavfPosting> {
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
  const pool = await getPool();

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
    .input('matched_by', sql.UniqueIdentifier, input.matched_by ?? null)
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
    .input('created_by', sql.UniqueIdentifier, input.matched_by ?? null)
    .query(
      `INSERT INTO event
         (event_id, title, event_date, location, capacity, status, created_by, created_at, updated_at)
       VALUES
         (NEWID(), @title, @event_date, @location, @capacity, 'published', @created_by, GETUTCDATE(), GETUTCDATE())`
    );

  await notifications.notifyMatchConfirmed(match.match_id);

  return match;
}

export async function cancelMatch(matchId: string): Promise<TavfMatch | null> {
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
