import { getPool, sql } from '../db';

export interface Group {
  group_id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateGroupInput {
  name: string;
  description?: string | null;
}

export interface UpdateGroupInput {
  name?: string;
  description?: string | null;
}

export interface MemberGroupMembership {
  member_id: string;
  group_id: string;
  assigned_at: Date;
}

// ---------------------------------------------------------------------------
// Group CRUD
// ---------------------------------------------------------------------------

export async function listGroups(): Promise<Group[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query<Group>('SELECT * FROM [group] ORDER BY is_system DESC, name');
  return result.recordset;
}

export async function getGroupById(groupId: string): Promise<Group | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query<Group>('SELECT * FROM [group] WHERE group_id = @group_id');
  return result.recordset[0] ?? null;
}

export async function createGroup(input: CreateGroupInput): Promise<Group> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('name', sql.NVarChar, input.name.trim())
    .input('description', sql.NVarChar, input.description ?? null)
    .query<Group>(
      `INSERT INTO [group] (name, description, is_system)
       OUTPUT INSERTED.*
       VALUES (@name, @description, 0)`,
    );
  return result.recordset[0];
}

export async function updateGroup(groupId: string, input: UpdateGroupInput): Promise<Group | null> {
  const existing = await getGroupById(groupId);
  if (!existing) return null;

  if (existing.is_system) {
    throw Object.assign(new Error('System groups cannot be modified.'), { statusCode: 403 });
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .input('name', sql.NVarChar, input.name !== undefined ? input.name.trim() : existing.name)
    .input('description', sql.NVarChar, 'description' in input ? (input.description ?? null) : existing.description)
    .query<Group>(
      `UPDATE [group] SET
         name        = @name,
         description = @description,
         updated_at  = GETDATE()
       OUTPUT INSERTED.*
       WHERE group_id = @group_id`,
    );
  return result.recordset[0] ?? null;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const existing = await getGroupById(groupId);
  if (!existing) return false;

  if (existing.is_system) {
    throw Object.assign(new Error('System groups cannot be deleted.'), { statusCode: 403 });
  }

  const pool = await getPool();
  // Remove all memberships first, then delete the group
  await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query('DELETE FROM member_group WHERE group_id = @group_id');

  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query('DELETE FROM [group] WHERE group_id = @group_id');

  return (result.rowsAffected[0] ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Member-Group assignment
// ---------------------------------------------------------------------------

export async function getGroupMembers(groupId: string): Promise<string[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query<{ member_id: string }>(
      'SELECT member_id FROM member_group WHERE group_id = @group_id',
    );
  return result.recordset.map((r) => r.member_id);
}

export async function getMemberGroups(memberId: string): Promise<Group[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Group>(
      `SELECT g.* FROM [group] g
       INNER JOIN member_group mg ON g.group_id = mg.group_id
       WHERE mg.member_id = @member_id
       ORDER BY g.is_system DESC, g.name`,
    );
  return result.recordset;
}

export async function addMemberToGroup(memberId: string, groupId: string): Promise<void> {
  const pool = await getPool();
  // Idempotent – use MERGE to avoid duplicate key errors
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query(
      `MERGE member_group AS target
       USING (SELECT @member_id AS member_id, @group_id AS group_id) AS source
         ON target.member_id = source.member_id AND target.group_id = source.group_id
       WHEN NOT MATCHED THEN
         INSERT (member_id, group_id) VALUES (source.member_id, source.group_id);`,
    );
}

export async function removeMemberFromGroup(memberId: string, groupId: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query('DELETE FROM member_group WHERE member_id = @member_id AND group_id = @group_id');
  return (result.rowsAffected[0] ?? 0) > 0;
}
