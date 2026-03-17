import { getPool, sql } from '../db';

interface Group {
  group_id: string;
  group_name: string;
  description: string | null;
  is_system: boolean;
  created_at: Date;
}

interface CreateGroupInput {
  group_name: string;
  description?: string | null;
}

interface UpdateGroupInput {
  group_name?: string;
  description?: string | null;
}

async function listGroups(): Promise<Group[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query<Group>('SELECT * FROM [group] ORDER BY is_system DESC, group_name');

  return result.recordset;
}

async function getGroupById(groupId: string): Promise<Group | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query<Group>('SELECT * FROM [group] WHERE group_id = @group_id');

  return result.recordset[0] ?? null;
}

async function createGroup(input: CreateGroupInput): Promise<Group> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_name', sql.NVarChar, input.group_name.trim())
    .input('description', sql.NVarChar, input.description ?? null)
    .query<Group>(
      `INSERT INTO [group] (group_name, description, is_system)
       OUTPUT INSERTED.*
       VALUES (@group_name, @description, 0)`
    );

  return result.recordset[0];
}

async function updateGroup(groupId: string, input: UpdateGroupInput): Promise<Group | null> {
  const existing = await getGroupById(groupId);
  if (!existing) {
    return null;
  }

  if (existing.is_system) {
    throw Object.assign(new Error('System groups cannot be modified.'), { statusCode: 403 });
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .input('group_name', sql.NVarChar, input.group_name !== undefined ? input.group_name.trim() : existing.group_name)
    .input('description', sql.NVarChar, 'description' in input ? (input.description ?? null) : existing.description)
    .query<Group>(
      `UPDATE [group] SET
         group_name = @group_name,
         description = @description
       OUTPUT INSERTED.*
       WHERE group_id = @group_id`
    );

  return result.recordset[0] ?? null;
}

async function deleteGroup(groupId: string): Promise<boolean> {
  const existing = await getGroupById(groupId);
  if (!existing) {
    return false;
  }

  if (existing.is_system) {
    throw Object.assign(new Error('System groups cannot be deleted.'), { statusCode: 403 });
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query('DELETE FROM [group] WHERE group_id = @group_id');

  return (result.rowsAffected[0] ?? 0) > 0;
}

async function getGroupMembers(groupId: string): Promise<string[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query<{ member_id: string }>('SELECT member_id FROM member_group WHERE group_id = @group_id');

  return result.recordset.map((row) => row.member_id);
}

async function getMemberGroups(memberId: string): Promise<Group[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Group>(
      `SELECT g.* FROM [group] g
       INNER JOIN member_group mg ON g.group_id = mg.group_id
       WHERE mg.member_id = @member_id
       ORDER BY g.is_system DESC, g.group_name`
    );

  return result.recordset;
}

async function addMemberToGroup(memberId: string, groupId: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query(
      `IF NOT EXISTS (
         SELECT 1 FROM member_group
         WHERE member_id = @member_id AND group_id = @group_id
       )
       BEGIN
         INSERT INTO member_group (member_id, group_id)
         VALUES (@member_id, @group_id)
       END`
    );
}

async function removeMemberFromGroup(memberId: string, groupId: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query('DELETE FROM member_group WHERE member_id = @member_id AND group_id = @group_id');

  return (result.rowsAffected[0] ?? 0) > 0;
}

export {
  addMemberToGroup,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupMembers,
  getMemberGroups,
  listGroups,
  removeMemberFromGroup,
  updateGroup,
};
export type { CreateGroupInput, Group, UpdateGroupInput };