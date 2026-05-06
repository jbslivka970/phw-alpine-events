import { getPool, sql } from '../db';
import { toE164 } from '../utils/phone';
import { isGraphRoleManagementConfigured, deleteEntraUser } from './graphRoleService';

interface Member {
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
  personas: string | null;
}

interface CreateMemberInput {
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

interface UpdateMemberInput {
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

interface MemberListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  isActive?: boolean;
}

async function findByComposite(
  email: string,
  firstName: string,
  lastName: string
): Promise<Member | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('email', sql.NVarChar, email.toLowerCase().trim())
    .input('first_name', sql.NVarChar, firstName.trim())
    .input('last_name', sql.NVarChar, lastName.trim())
    .query<Member>(
      `SELECT * FROM member
       WHERE LOWER(email) = @email
         AND first_name = @first_name
         AND last_name = @last_name`
    );

  return result.recordset[0] ?? null;
}

async function getMemberById(memberId: string): Promise<Member | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Member>('SELECT * FROM member WHERE member_id = @member_id');

  return result.recordset[0] ?? null;
}

async function listMembers(opts: MemberListOptions = {}): Promise<{ data: Member[]; total: number }> {
  const { isActive, page = 1, pageSize = 50, search } = opts;
  const offset = (page - 1) * pageSize;
  const pool = await getPool();

  let where = 'WHERE 1=1';
  if (isActive !== undefined) {
    where += ' AND is_active = @is_active';
  }
  if (search) {
    where += ' AND (first_name LIKE @search OR last_name LIKE @search OR email LIKE @search)';
  }

  const applyInputs = (request: sql.Request) => {
    if (isActive !== undefined) {
      request.input('is_active', sql.Bit, isActive ? 1 : 0);
    }
    if (search) {
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    return request;
  };

  const dataRequest = applyInputs(pool.request())
    .input('offset', sql.Int, offset)
    .input('pageSize', sql.Int, pageSize);

  const [dataResult, countResult] = await Promise.all([
    dataRequest.query<Member>(
      `SELECT m.*,
              (SELECT STRING_AGG(mp.persona, ',') WITHIN GROUP (ORDER BY mp.persona)
               FROM dbo.member_persona mp
               WHERE mp.member_id = m.member_id) AS personas
       FROM member m ${where}
       ORDER BY m.last_name, m.first_name
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`
    ),
    applyInputs(pool.request()).query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM member ${where}`
    ),
  ]);

  return {
    data: dataResult.recordset,
    total: countResult.recordset[0]?.total ?? 0,
  };
}

async function createMember(input: CreateMemberInput): Promise<Member> {
  const phone = toE164(input.mobile_phone ?? null);

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
          @email_opt_out, @salutation, @title, @account_name, @source)`
    );

  return result.recordset[0];
}

async function updateMember(memberId: string, input: UpdateMemberInput): Promise<Member | null> {
  const existing = await getMemberById(memberId);
  if (!existing) {
    return null;
  }

  const phone = 'mobile_phone' in input ? toE164(input.mobile_phone ?? null) : existing.mobile_phone;
  const firstName = input.first_name ?? existing.first_name;
  const lastName = input.last_name ?? existing.last_name;
  const email = input.email ? input.email.toLowerCase().trim() : existing.email;

  const identityChanged =
    input.first_name !== undefined ||
    input.last_name !== undefined ||
    input.email !== undefined;

  if (identityChanged) {
    const conflict = await findByComposite(email, firstName, lastName);
    if (conflict && conflict.member_id !== memberId) {
      throw Object.assign(
        new Error('Another member with that email, first name, and last name already exists.'),
        { statusCode: 409 }
      );
    }
  }

  const bitFor = (value: boolean | undefined, fallback: boolean): number =>
    (value !== undefined ? value : fallback) ? 1 : 0;

  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('first_name', sql.NVarChar, firstName)
    .input('last_name', sql.NVarChar, lastName)
    .input('email', sql.NVarChar, email)
    .input('mobile_phone', sql.NVarChar, phone)
    .input('sms_opt_in', sql.Bit, bitFor(input.sms_opt_in, existing.sms_opt_in))
    .input('email_opt_out', sql.Bit, bitFor(input.email_opt_out, existing.email_opt_out))
    .input('salutation', sql.NVarChar, 'salutation' in input ? (input.salutation ?? null) : existing.salutation)
    .input('title', sql.NVarChar, 'title' in input ? (input.title ?? null) : existing.title)
    .input('account_name', sql.NVarChar, 'account_name' in input ? (input.account_name ?? null) : existing.account_name)
    .query<Member>(
      `UPDATE member SET
         first_name      = @first_name,
         last_name       = @last_name,
         email           = @email,
         mobile_phone    = @mobile_phone,
         sms_opt_in      = @sms_opt_in,
         email_opt_out   = @email_opt_out,
         salutation      = @salutation,
         title           = @title,
         account_name    = @account_name,
         last_manual_edit = GETUTCDATE(),
         updated_at      = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE member_id = @member_id`
    );

  return result.recordset[0] ?? null;
}

async function deactivateMember(memberId: string): Promise<Member | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Member>(
      `UPDATE member SET
         is_active = 0,
         updated_at = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE member_id = @member_id`
    );

  return result.recordset[0] ?? null;
}

async function hardDeleteMember(memberId: string): Promise<Member | null> {
  const pool = await getPool();

  // Capture the linked Entra object ID BEFORE the transaction, because the CASCADE
  // on member_identity_link will remove it when the member row is deleted.
  // Also guard against deleting the CIAM identity of an active admin user — if this
  // member's email is still an active admin account we skip the Entra deletion so the
  // admin does not get locked out.
  let entraObjectIdToDelete: string | null = null;
  if (isGraphRoleManagementConfigured()) {
    const linkResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ entra_object_id: string | null; last_seen_email: string | null }>(
        `SELECT TOP 1 entra_object_id, last_seen_email
         FROM dbo.member_identity_link
         WHERE member_id = @member_id`
      );
    const link = linkResult.recordset[0];
    if (link?.entra_object_id) {
      const adminCheck = await pool
        .request()
        .input('email', sql.NVarChar(255), (link.last_seen_email ?? '').toLowerCase())
        .query<{ user_id: string }>(
          `SELECT TOP 1 user_id FROM [user]
           WHERE email = @email AND is_active = 1`
        );
      if (adminCheck.recordset[0]) {
        console.info(
          '[hardDelete] skipping Entra user deletion for member %s — email is an active admin user',
          memberId
        );
      } else {
        entraObjectIdToDelete = link.entra_object_id;
      }
    }
  }

  const tx = pool.transaction();
  await tx.begin();
  let deletedMember: Member | null = null;
  try {
    const req = () => tx.request().input('member_id', sql.UniqueIdentifier, memberId);

    // Guard optional tables for compatibility with environments on older schema revisions.
    await req().query(`
      IF OBJECT_ID(N'dbo.event_notification_target', N'U') IS NOT NULL
        DELETE FROM dbo.event_notification_target WHERE member_id = @member_id;

      IF OBJECT_ID(N'dbo.event_response', N'U') IS NOT NULL
        DELETE FROM dbo.event_response WHERE member_id = @member_id;

      IF OBJECT_ID(N'dbo.event_assignment', N'U') IS NOT NULL
        DELETE FROM dbo.event_assignment WHERE member_id = @member_id;

      IF OBJECT_ID(N'dbo.notification_log', N'U') IS NOT NULL
        UPDATE dbo.notification_log SET member_id = NULL WHERE member_id = @member_id;

      IF OBJECT_ID(N'dbo.inbound_sms_log', N'U') IS NOT NULL
        UPDATE dbo.inbound_sms_log SET member_id = NULL WHERE member_id = @member_id;

      IF OBJECT_ID(N'dbo.email_preference_log', N'U') IS NOT NULL
        UPDATE dbo.email_preference_log SET member_id = NULL WHERE member_id = @member_id;

      IF OBJECT_ID(N'dbo.tavf_application', N'U') IS NOT NULL
        DELETE FROM dbo.tavf_application WHERE vet_member_id = @member_id;

      IF OBJECT_ID(N'dbo.tavf_posting', N'U') IS NOT NULL
      BEGIN
        IF OBJECT_ID(N'dbo.tavf_application', N'U') IS NOT NULL
          DELETE FROM dbo.tavf_application
          WHERE posting_id IN (
            SELECT posting_id FROM dbo.tavf_posting WHERE guide_member_id = @member_id
          );

        DELETE FROM dbo.tavf_posting WHERE guide_member_id = @member_id;
      END

      -- Safety pass for schema drift: clean any remaining non-cascade foreign keys to dbo.member.
      DECLARE @memberTableId INT = OBJECT_ID(N'dbo.member', N'U');
      IF @memberTableId IS NOT NULL
      BEGIN
        DECLARE @memberRefs TABLE (
          schema_name SYSNAME NOT NULL,
          table_name SYSNAME NOT NULL,
          column_name SYSNAME NOT NULL,
          delete_action TINYINT NOT NULL,
          is_nullable BIT NOT NULL
        );

        INSERT INTO @memberRefs (schema_name, table_name, column_name, delete_action, is_nullable)
        SELECT
          s.name,
          t.name,
          c.name,
          fk.delete_referential_action,
          c.is_nullable
        FROM sys.foreign_key_columns fkc
        INNER JOIN sys.foreign_keys fk
          ON fk.object_id = fkc.constraint_object_id
        INNER JOIN sys.tables t
          ON t.object_id = fkc.parent_object_id
        INNER JOIN sys.schemas s
          ON s.schema_id = t.schema_id
        INNER JOIN sys.columns c
          ON c.object_id = fkc.parent_object_id
         AND c.column_id = fkc.parent_column_id
        WHERE fkc.referenced_object_id = @memberTableId
          AND NOT (s.name = N'dbo' AND t.name = N'member');

        DECLARE @schemaName SYSNAME;
        DECLARE @tableName SYSNAME;
        DECLARE @columnName SYSNAME;
        DECLARE @isNullable BIT;
        DECLARE @sql NVARCHAR(MAX);

        -- Preserve history where possible by nulling member references instead of deleting rows.
        DECLARE preserve_cursor CURSOR LOCAL FAST_FORWARD FOR
          SELECT schema_name, table_name, column_name, is_nullable
          FROM @memberRefs
          WHERE delete_action <> 1
            AND schema_name = N'dbo'
            AND table_name IN (N'notification_log', N'inbound_sms_log', N'email_preference_log', N'tavf_match');

        OPEN preserve_cursor;
        FETCH NEXT FROM preserve_cursor INTO @schemaName, @tableName, @columnName, @isNullable;
        WHILE @@FETCH_STATUS = 0
        BEGIN
          SET @sql =
            CASE
              WHEN @isNullable = 1 THEN
                N'UPDATE ' + QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName) +
                N' SET ' + QUOTENAME(@columnName) + N' = NULL WHERE ' + QUOTENAME(@columnName) + N' = @member_id;'
              ELSE
                N'DELETE FROM ' + QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName) +
                N' WHERE ' + QUOTENAME(@columnName) + N' = @member_id;'
            END;

          EXEC sp_executesql @sql, N'@member_id UNIQUEIDENTIFIER', @member_id = @member_id;
          FETCH NEXT FROM preserve_cursor INTO @schemaName, @tableName, @columnName, @isNullable;
        END
        CLOSE preserve_cursor;
        DEALLOCATE preserve_cursor;

        -- Remove remaining blockers for hard-delete when FK does not cascade.
        DECLARE delete_cursor CURSOR LOCAL FAST_FORWARD FOR
          SELECT schema_name, table_name, column_name
          FROM @memberRefs
          WHERE delete_action <> 1
            AND NOT (
              schema_name = N'dbo' AND table_name IN (N'notification_log', N'inbound_sms_log', N'email_preference_log', N'tavf_match')
            );

        OPEN delete_cursor;
        FETCH NEXT FROM delete_cursor INTO @schemaName, @tableName, @columnName;
        WHILE @@FETCH_STATUS = 0
        BEGIN
          SET @sql =
            N'DELETE FROM ' + QUOTENAME(@schemaName) + N'.' + QUOTENAME(@tableName) +
            N' WHERE ' + QUOTENAME(@columnName) + N' = @member_id;';

          EXEC sp_executesql @sql, N'@member_id UNIQUEIDENTIFIER', @member_id = @member_id;
          FETCH NEXT FROM delete_cursor INTO @schemaName, @tableName, @columnName;
        END
        CLOSE delete_cursor;
        DEALLOCATE delete_cursor;
      END
    `);

    // Delete member (cascades: member_group, sms_consent_log, member_identity_link, waitlist_promotion_offer)
    const result = await req().query<Member>(
      `DELETE FROM dbo.member OUTPUT DELETED.* WHERE member_id = @member_id`
    );

    await tx.commit();
    deletedMember = result.recordset[0] ?? null;
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  // Best-effort Entra user deletion — runs after the DB transaction so a Graph failure
  // does not roll back the already-committed purge.
  if (entraObjectIdToDelete) {
    try {
      await deleteEntraUser(entraObjectIdToDelete);
      console.info('[hardDelete] Entra user deleted: %s', entraObjectIdToDelete);
    } catch (entraErr) {
      console.warn('[hardDelete] Entra user deletion failed (non-fatal)', {
        entraObjectId: entraObjectIdToDelete,
        memberId,
        error: entraErr instanceof Error ? entraErr.message : String(entraErr),
      });
    }
  }

  return deletedMember;
}

export {
  createMember,
  deactivateMember,
  findByComposite,
  getMemberById,
  hardDeleteMember,
  listMembers,
  updateMember,
};
export type { CreateMemberInput, Member, MemberListOptions, UpdateMemberInput };