/*
  Tenant membership audit (read-only)

  Purpose:
  - Confirm Colorado Alpine tenant is present and active.
  - Confirm sarnitro@gmail.com has the expected tenant memberships.
  - Confirm no other users have active memberships in multiple tenants.
  - Confirm Colorado Alpine admins remain admin-equivalent in tenant_membership.

  Notes:
  - This script is read-only. It does not modify data.
  - Run in Azure SQL against the production database.
*/

SET NOCOUNT ON;

DECLARE @colorado_tenant_id UNIQUEIDENTIFIER;
DECLARE @colorado_slug NVARCHAR(100) = N'colorado-alpine';
DECLARE @master_email NVARCHAR(255) = N'sarnitro@gmail.com';

SELECT TOP (1)
  @colorado_tenant_id = t.tenant_id
FROM dbo.tenant t
WHERE t.slug = @colorado_slug;

PRINT N'--- 1) Tenant baseline ---';
SELECT
  t.tenant_id,
  t.slug,
  t.display_name,
  t.tenant_type,
  t.status,
  t.is_demo,
  t.is_operational,
  t.timezone,
  t.created_at
FROM dbo.tenant t
WHERE t.slug IN (N'colorado-alpine', N'demo')
ORDER BY t.slug;

PRINT N'--- 2) Master account user row ---';
SELECT
  u.user_id,
  u.email,
  u.display_name,
  u.role,
  u.is_active,
  u.is_root,
  u.root_role,
  u.last_login,
  u.created_at,
  u.updated_at
FROM dbo.[user] u
WHERE LOWER(u.email) = LOWER(@master_email);

PRINT N'--- 3) Master account member row(s) ---';
SELECT
  m.member_id,
  m.first_name,
  m.last_name,
  m.email,
  m.is_active,
  m.created_at,
  m.updated_at
FROM dbo.member m
WHERE LOWER(m.email) = LOWER(@master_email)
ORDER BY m.created_at ASC, m.member_id ASC;

PRINT N'--- 4) Master account tenant memberships (user + member) ---';
SELECT
  tm.tenant_membership_id,
  tm.tenant_id,
  t.slug AS tenant_slug,
  t.display_name AS tenant_name,
  tm.user_id,
  tm.member_id,
  tm.role,
  tm.membership_kind,
  tm.home_tenant_id,
  tm.starts_at,
  tm.expires_at,
  tm.status,
  tm.revoked_at,
  tm.created_at
FROM dbo.tenant_membership tm
JOIN dbo.tenant t ON t.tenant_id = tm.tenant_id
LEFT JOIN dbo.[user] u ON u.user_id = tm.user_id
LEFT JOIN dbo.member m ON m.member_id = tm.member_id
WHERE (u.email IS NOT NULL AND LOWER(u.email) = LOWER(@master_email))
   OR (m.email IS NOT NULL AND LOWER(m.email) = LOWER(@master_email))
ORDER BY tm.status DESC, tm.starts_at DESC, tm.created_at DESC;

PRINT N'--- 5) Active multi-tenant users (should normally be only master account) ---';
WITH active_user_tenants AS (
  SELECT
    tm.user_id,
    COUNT(DISTINCT tm.tenant_id) AS active_tenant_count
  FROM dbo.tenant_membership tm
  WHERE tm.user_id IS NOT NULL
    AND tm.status = N'active'
    AND tm.revoked_at IS NULL
    AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
  GROUP BY tm.user_id
)
SELECT
  u.user_id,
  u.email,
  u.display_name,
  u.role,
  u.is_root,
  u.root_role,
  aut.active_tenant_count
FROM active_user_tenants aut
JOIN dbo.[user] u ON u.user_id = aut.user_id
WHERE aut.active_tenant_count > 1
ORDER BY aut.active_tenant_count DESC, u.email ASC;

PRINT N'--- 6) Colorado Alpine admin-equivalent memberships ---';
SELECT
  tm.tenant_membership_id,
  tm.tenant_id,
  t.slug AS tenant_slug,
  tm.user_id,
  u.email,
  u.display_name,
  u.role AS user_role,
  tm.role AS membership_role,
  tm.membership_kind,
  tm.status,
  tm.expires_at,
  tm.revoked_at,
  tm.created_at
FROM dbo.tenant_membership tm
JOIN dbo.tenant t ON t.tenant_id = tm.tenant_id
LEFT JOIN dbo.[user] u ON u.user_id = tm.user_id
WHERE tm.tenant_id = @colorado_tenant_id
  AND tm.user_id IS NOT NULL
  AND tm.status = N'active'
  AND tm.revoked_at IS NULL
  AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
  AND tm.role IN (N'admin', N'root_admin', N'support', N'event_creator', N'tavf_creator')
ORDER BY tm.role, u.email;

PRINT N'--- 7) Potentially stale admin mapping in Colorado Alpine (user says admin/superadmin but membership not admin-equivalent) ---';
SELECT
  u.user_id,
  u.email,
  u.display_name,
  u.role AS user_role,
  tm.tenant_membership_id,
  tm.role AS membership_role,
  tm.status,
  tm.revoked_at,
  tm.expires_at
FROM dbo.[user] u
LEFT JOIN dbo.tenant_membership tm
  ON tm.user_id = u.user_id
 AND tm.tenant_id = @colorado_tenant_id
 AND tm.membership_kind = N'home'
 AND tm.status = N'active'
 AND tm.revoked_at IS NULL
 AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
WHERE u.is_active = 1
  AND LOWER(COALESCE(u.role, N'')) IN (N'admin', N'superadmin')
  AND (tm.tenant_membership_id IS NULL OR tm.role NOT IN (N'admin', N'root_admin', N'support'))
ORDER BY u.email;

PRINT N'--- 8) Summary counters ---';
SELECT
  SUM(CASE WHEN tm.status = N'active' AND tm.revoked_at IS NULL AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE()) THEN 1 ELSE 0 END) AS active_memberships,
  SUM(CASE WHEN tm.user_id IS NOT NULL THEN 1 ELSE 0 END) AS user_linked_memberships,
  SUM(CASE WHEN tm.member_id IS NOT NULL THEN 1 ELSE 0 END) AS member_linked_memberships
FROM dbo.tenant_membership tm;
