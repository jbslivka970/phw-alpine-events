import { getPool, sql } from '../db';
import { toE164 } from '../utils/phone';

export interface Member {
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone: string | null;
  sms_opt_in: boolean;
  sms_opt_in_date: Date | null;
  sms_opt_out_date: Date | null;
  email_opt_out: boolean;
  salutation: string | null;
  title: string | null;
  account_name: string | null;
  source: 'import' | 'manual' | null;
  last_import_hash: string | null;
  last_manual_edit: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMemberInput {
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone?: string | null;
  sms_opt_in?: boolean;
  email_opt_out?: boolean;
  salutation?: string | null;
  title?: string | null;
  account_name?: string | null;
  source?: 'import' | 'manual';
}

export interface UpdateMemberInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  mobile_phone?: string | null;
  sms_opt_in?: boolean;
  email_opt_out?: boolean;
  salutation?: string | null;
  title?: string | null;
  account_name?: string | null;
}

export interface MemberListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  isActive?: boolean;
}

/**
 * Find an existing member by composite key (email + first_name + last_name).
 * Per PRD: this triplet uniquely identifies a member.
 */
export async function findByComposite(
  email: string,
  first_name: string,
  last_name: string,
): Promise<Member | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('email', sql.NVarChar, email.toLowerCase().trim())
    .input('first_name', sql.NVarChar, first_name.trim())
    .input('last_name', sql.NVarChar, last_name.trim())
    .query<Member>(
      `SELECT * FROM member
       WHERE LOWER(email) = @email
         AND first_name = @first_name
         AND last_name  = @last_name`,
    );
  return result.recordset[0] ?? null;
}

export async function getMemberById(memberId: string): Promise<Member | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Member>('SELECT * FROM member WHERE member_id = @member_id');
  return result.recordset[0] ?? null;
}

export async function listMembers(opts: MemberListOptions = {}): Promise<{ data: Member[]; total: number }> {
  const { page = 1, pageSize = 50, search, isActive } = opts;
  const offset = (page - 1) * pageSize;

  const pool = await getPool();

  // Build WHERE clause; both the data request and the count request get the same inputs
  let where = 'WHERE 1=1';
  const applyFilters = (req: ReturnType<typeof pool.request>) => {
    if (isActive !== undefined) {
      req.input('is_active', sql.Bit, isActive ? 1 : 0);
    }
    if (search) {
      req.input('search', sql.NVarChar, `%${search}%`);
    }
    return req;
  };

  if (isActive !== undefined) {
    where += ' AND is_active = @is_active';
  }
  if (search) {
    where += ` AND (first_name LIKE @search OR last_name LIKE @search OR email LIKE @search)`;
  }

  const dataReq = applyFilters(pool.request());
  dataReq.input('offset', sql.Int, offset);
  dataReq.input('pageSize', sql.Int, pageSize);

  const [dataResult, countResult] = await Promise.all([
    dataReq.query<Member>(
      `SELECT * FROM member ${where}
       ORDER BY last_name, first_name
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    ),
    applyFilters(pool.request()).query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM member ${where}`,
    ),
  ]);

  return {
    data: dataResult.recordset,
    total: countResult.recordset[0]?.total ?? 0,
  };
}

export async function createMember(input: CreateMemberInput): Promise<Member> {
  const phone = toE164(input.mobile_phone ?? null);

  // Check composite uniqueness
  const existing = await findByComposite(input.email, input.first_name, input.last_name);
  if (existing) {
    throw Object.assign(new Error('A member with that email, first name, and last name already exists.'), {
      statusCode: 409,
    });
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('first_name', sql.NVarChar, input.first_name.trim())
    .input('last_name', sql.NVarChar, input.last_name.trim())
    .input('email', sql.NVarChar, input.email.toLowerCase().trim())
    .input('mobile_phone', sql.NVarChar, phone)
    .input('sms_opt_in', sql.Bit, input.sms_opt_in ? 1 : 0)
    .input('email_opt_out', sql.Bit, input.email_opt_out ? 1 : 0)
    .input('salutation', sql.NVarChar, input.salutation ?? null)
    .input('title', sql.NVarChar, input.title ?? null)
    .input('account_name', sql.NVarChar, input.account_name ?? null)
    .input('source', sql.NVarChar, input.source ?? 'manual')
    .query<Member>(
      `INSERT INTO member
         (first_name, last_name, email, mobile_phone, sms_opt_in,
          email_opt_out, salutation, title, account_name, source)
       OUTPUT INSERTED.*
       VALUES
         (@first_name, @last_name, @email, @mobile_phone, @sms_opt_in,
          @email_opt_out, @salutation, @title, @account_name, @source)`,
    );
  return result.recordset[0];
}

export async function updateMember(memberId: string, input: UpdateMemberInput): Promise<Member | null> {
  const existing = await getMemberById(memberId);
  if (!existing) return null;

  const phone =
    'mobile_phone' in input ? toE164(input.mobile_phone ?? null) : existing.mobile_phone;

  const first_name  = input.first_name  ?? existing.first_name;
  const last_name   = input.last_name   ?? existing.last_name;
  const email       = input.email       ? input.email.toLowerCase().trim() : existing.email;

  // Composite uniqueness check (only if identity fields changed)
  const identityChanged =
    input.first_name !== undefined ||
    input.last_name  !== undefined ||
    input.email      !== undefined;

  if (identityChanged) {
    const conflict = await findByComposite(email, first_name, last_name);
    if (conflict && conflict.member_id !== memberId) {
      throw Object.assign(
        new Error('Another member with that email, first name, and last name already exists.'),
        { statusCode: 409 },
      );
    }
  }

  const pool = await getPool();

  const bitFor = (val: boolean | undefined, fallback: boolean): number =>
    (val !== undefined ? val : fallback) ? 1 : 0;

  const sms_opt_in   = bitFor(input.sms_opt_in,   existing.sms_opt_in);
  const email_opt_out = bitFor(input.email_opt_out, existing.email_opt_out);
  const salutation   = 'salutation'   in input ? (input.salutation   ?? null) : existing.salutation;
  const title        = 'title'        in input ? (input.title        ?? null) : existing.title;
  const account_name = 'account_name' in input ? (input.account_name ?? null) : existing.account_name;

  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('first_name', sql.NVarChar, first_name)
    .input('last_name', sql.NVarChar, last_name)
    .input('email', sql.NVarChar, email)
    .input('mobile_phone', sql.NVarChar, phone)
    .input('sms_opt_in', sql.Bit, sms_opt_in)
    .input('email_opt_out', sql.Bit, email_opt_out)
    .input('salutation', sql.NVarChar, salutation)
    .input('title', sql.NVarChar, title)
    .input('account_name', sql.NVarChar, account_name)
    .query<Member>(
      `UPDATE member SET
         first_name   = @first_name,
         last_name    = @last_name,
         email        = @email,
         mobile_phone = @mobile_phone,
         sms_opt_in   = @sms_opt_in,
         email_opt_out = @email_opt_out,
         salutation   = @salutation,
         title        = @title,
         account_name = @account_name,
         last_manual_edit = GETDATE(),
         updated_at   = GETDATE()
       OUTPUT INSERTED.*
       WHERE member_id = @member_id`,
    );
  return result.recordset[0] ?? null;
}

/**
 * Soft-delete: set is_active = 0. Per PRD members are never hard-deleted.
 */
export async function deactivateMember(memberId: string): Promise<Member | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Member>(
      `UPDATE member SET is_active = 0, updated_at = GETDATE()
       OUTPUT INSERTED.*
       WHERE member_id = @member_id`,
    );
  return result.recordset[0] ?? null;
}
