import { getPool, sql } from '../db';

const DEFAULT_TENANT_ID = (process.env['DEFAULT_TENANT_ID'] ?? '1b6b9719-663a-4e56-8f7d-9a4bd4c10001').trim().toLowerCase();

interface Group {
  group_id: string;
  tenant_id: string;
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

interface GroupScopeOptions {
  tenantId?: string;
}

function isMultiTenantEnabled(): boolean {
  const raw = process.env['MULTI_TENANT_ENABLED'];
  if (!raw) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function shouldApplyTenantScope(tenantId: string | undefined): tenantId is string {
  return isMultiTenantEnabled() && Boolean(tenantId?.trim());
}

function applyTenantInput(request: sql.Request, tenantId: string | undefined): sql.Request {
  if (!shouldApplyTenantScope(tenantId)) {
    return request;
  }

  return request.input('tenant_id', sql.UniqueIdentifier, tenantId);
}

function requireScopedTenantId(scope: GroupScopeOptions): string {
  if (scope.tenantId?.trim()) {
    return scope.tenantId;
  }

  if (!isMultiTenantEnabled()) {
    return DEFAULT_TENANT_ID;
  }

  throw Object.assign(new Error('Active tenant context is required for this operation.'), { statusCode: 400 });
}

async function listGroups(scope: GroupScopeOptions = {}): Promise<Group[]> {
  const pool = await getPool();
  const result = await applyTenantInput(pool.request(), scope.tenantId)
    .query<Group>(
      `SELECT g.*
       FROM [group] g
       ${shouldApplyTenantScope(scope.tenantId) ? 'WHERE g.tenant_id = @tenant_id' : ''}
       ORDER BY g.is_system DESC, g.group_name`
    );

  return result.recordset;
}

async function getGroupById(groupId: string, scope: GroupScopeOptions = {}): Promise<Group | null> {
  const pool = await getPool();
  const result = await applyTenantInput(pool.request(), scope.tenantId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query<Group>(
      `SELECT g.*
       FROM [group] g
       WHERE g.group_id = @group_id
       ${shouldApplyTenantScope(scope.tenantId) ? 'AND g.tenant_id = @tenant_id' : ''}`
    );

  return result.recordset[0] ?? null;
}

async function createGroup(input: CreateGroupInput, scope: GroupScopeOptions = {}): Promise<Group> {
  const tenantId = requireScopedTenantId(scope);
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('group_name', sql.NVarChar, input.group_name.trim())
    .input('description', sql.NVarChar, input.description ?? null)
    .query<Group>(
      `INSERT INTO [group] (tenant_id, group_name, description, is_system)
       OUTPUT INSERTED.*
       VALUES (@tenant_id, @group_name, @description, 0)`
    );

  return result.recordset[0];
}

async function updateGroup(groupId: string, input: UpdateGroupInput, scope: GroupScopeOptions = {}): Promise<Group | null> {
  const existing = await getGroupById(groupId, scope);
  if (!existing) {
    return null;
  }

  if (existing.is_system) {
    throw Object.assign(new Error('System groups cannot be modified.'), { statusCode: 403 });
  }

  const pool = await getPool();
  const result = await applyTenantInput(pool.request(), scope.tenantId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .input('group_name', sql.NVarChar, input.group_name !== undefined ? input.group_name.trim() : existing.group_name)
    .input('description', sql.NVarChar, 'description' in input ? (input.description ?? null) : existing.description)
    .query<Group>(
      `UPDATE [group] SET
         group_name = @group_name,
         description = @description
       OUTPUT INSERTED.*
       WHERE group_id = @group_id
       ${shouldApplyTenantScope(scope.tenantId) ? 'AND tenant_id = @tenant_id' : ''}`
    );

  return result.recordset[0] ?? null;
}

async function deleteGroup(groupId: string, scope: GroupScopeOptions = {}): Promise<boolean> {
  const existing = await getGroupById(groupId, scope);
  if (!existing) {
    return false;
  }

  if (existing.is_system) {
    throw Object.assign(new Error('System groups cannot be deleted.'), { statusCode: 403 });
  }

  const pool = await getPool();
  const result = await applyTenantInput(pool.request(), scope.tenantId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query(`DELETE FROM [group] WHERE group_id = @group_id ${shouldApplyTenantScope(scope.tenantId) ? 'AND tenant_id = @tenant_id' : ''}`);

  return (result.rowsAffected[0] ?? 0) > 0;
}

async function getGroupMembers(groupId: string, scope: GroupScopeOptions = {}): Promise<string[]> {
  const pool = await getPool();
  const result = await applyTenantInput(pool.request(), scope.tenantId)
    .input('group_id', sql.UniqueIdentifier, groupId)
    .query<{ member_id: string }>(
      `SELECT mg.member_id
       FROM member_group mg
       INNER JOIN [group] g ON g.group_id = mg.group_id
       INNER JOIN member m ON m.member_id = mg.member_id
       WHERE mg.group_id = @group_id
       ${shouldApplyTenantScope(scope.tenantId) ? 'AND g.tenant_id = @tenant_id' : ''}`
    );

  return result.recordset.map((row) => row.member_id);
}

async function getMemberGroups(memberId: string, scope: GroupScopeOptions = {}): Promise<Group[]> {
  const pool = await getPool();
  const result = await applyTenantInput(pool.request(), scope.tenantId)
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<Group>(
      `SELECT g.* FROM [group] g
       INNER JOIN member_group mg ON g.group_id = mg.group_id
       WHERE mg.member_id = @member_id
       ${shouldApplyTenantScope(scope.tenantId) ? 'AND g.tenant_id = @tenant_id' : ''}
       ORDER BY g.is_system DESC, g.group_name`
    );

  return result.recordset;
}

async function addMemberToGroup(memberId: string, groupId: string, scope: GroupScopeOptions = {}): Promise<void> {
  const tenantId = requireScopedTenantId(scope);
  const pool = await getPool();
  const request = pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('group_id', sql.UniqueIdentifier, groupId);

  await request.query(
    `IF NOT EXISTS (
       SELECT 1
       FROM dbo.[group] g
       WHERE g.group_id = @group_id
         AND g.tenant_id = @tenant_id
     )
     BEGIN
       THROW 51000, 'Group not found in active tenant scope.', 1;
     END

     IF NOT EXISTS (
       SELECT 1
       FROM dbo.tenant_membership tm
       WHERE tm.member_id = @member_id
         AND tm.tenant_id = @tenant_id
         AND tm.status = 'active'
         AND tm.revoked_at IS NULL
         AND tm.starts_at <= GETUTCDATE()
         AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
     )
     BEGIN
       THROW 51000, 'Member not found in active tenant scope.', 1;
     END

     IF NOT EXISTS (
       SELECT 1 FROM member_group
       WHERE member_id = @member_id AND group_id = @group_id
     )
     BEGIN
       INSERT INTO member_group (member_id, group_id)
       VALUES (@member_id, @group_id)
     END`
  );
}

async function removeMemberFromGroup(memberId: string, groupId: string, scope: GroupScopeOptions = {}): Promise<boolean> {
  const tenantId = requireScopedTenantId(scope);
  const pool = await getPool();
  const request = pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('group_id', sql.UniqueIdentifier, groupId);

  const result = await request.query(
    `DELETE mg
     FROM member_group mg
     INNER JOIN dbo.[group] g ON g.group_id = mg.group_id
     WHERE mg.member_id = @member_id
       AND mg.group_id = @group_id
       AND g.tenant_id = @tenant_id`
  );

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
export type { CreateGroupInput, Group, GroupScopeOptions, UpdateGroupInput };