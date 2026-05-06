import { randomUUID } from 'crypto';
import { getPool, sql } from '../db';

const MEMBER_INVITE_TOKEN_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

interface ClaimIdentityInviteInput {
  entraObjectId?: string | null;
  issuer?: string | null;
  issuerAssignedId?: string | null;
  identityProvider?: string | null;
  email?: string | null;
}

function normalizeMemberInviteToken(token?: string | null): string | null {
  if (!token) {
    return null;
  }

  const normalized = token.trim().toLowerCase();
  if (!MEMBER_INVITE_TOKEN_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

async function ensureIdentityInviteClaimTable(): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .query(
      `IF OBJECT_ID('identity_invite_claim', 'U') IS NULL
       BEGIN
         CREATE TABLE identity_invite_claim (
           claim_token UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
           member_id UNIQUEIDENTIFIER NOT NULL,
           email NVARCHAR(255) NOT NULL,
           invited_by NVARCHAR(255) NOT NULL,
           created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
           claimed_at DATETIME2(3) NULL,
           claimed_entra_object_id NVARCHAR(255) NULL,
           claimed_email NVARCHAR(255) NULL,
           last_claimed_at DATETIME2(3) NULL
         );

         CREATE INDEX IX_identity_invite_claim_member_created_at
           ON identity_invite_claim(member_id, created_at DESC);
       END;

       IF NOT EXISTS (
         SELECT 1
         FROM sys.foreign_keys
         WHERE name = 'FK_identity_invite_claim_member'
       )
       BEGIN
         ALTER TABLE identity_invite_claim
           ADD CONSTRAINT FK_identity_invite_claim_member
             FOREIGN KEY (member_id) REFERENCES dbo.member(member_id) ON DELETE CASCADE;
       END`
    );
}

export async function issueIdentityInviteClaim(memberId: string, email: string, invitedBy: string): Promise<{ claimToken: string }> {
  await ensureIdentityInviteClaimTable();

  const claimToken = randomUUID().toLowerCase();
  const pool = await getPool();
  await pool
    .request()
    .input('claim_token', sql.UniqueIdentifier, claimToken)
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('email', sql.NVarChar(255), email.trim().toLowerCase())
    .input('invited_by', sql.NVarChar(255), invitedBy)
    .query(
      `INSERT INTO identity_invite_claim (
         claim_token,
         member_id,
         email,
         invited_by
       )
       VALUES (
         @claim_token,
         @member_id,
         @email,
         @invited_by
       )`
    );

  return { claimToken };
}

export async function claimIdentityInvite(
  memberInviteToken: string | null | undefined,
  input: ClaimIdentityInviteInput
): Promise<string | null> {
  const normalizedToken = normalizeMemberInviteToken(memberInviteToken);
  if (!normalizedToken) {
    return null;
  }

  await ensureIdentityInviteClaimTable();

  const normalizedEntraObjectId = input.entraObjectId?.trim() || null;
  const normalizedIssuer = input.issuer?.trim() || null;
  const normalizedIssuerAssignedId = input.issuerAssignedId?.trim() || null;
  const normalizedIdentityProvider = input.identityProvider?.trim() || null;
  const normalizedEmail = input.email?.trim().toLowerCase() || null;

  const pool = await getPool();
  const claimLookup = await pool
    .request()
    .input('claim_token', sql.UniqueIdentifier, normalizedToken)
    .query<{
      member_id: string;
      claimed_entra_object_id: string | null;
    }>(
      `SELECT TOP 1
         ic.member_id,
         ic.claimed_entra_object_id
       FROM identity_invite_claim ic
       INNER JOIN member m ON m.member_id = ic.member_id
       WHERE ic.claim_token = @claim_token
         AND m.is_active = 1
       ORDER BY ic.created_at DESC`
    );

  const claim = claimLookup.recordset[0];
  if (!claim?.member_id) {
    return null;
  }

  if (claim.claimed_entra_object_id && normalizedEntraObjectId && claim.claimed_entra_object_id !== normalizedEntraObjectId) {
    return null;
  }

  await pool
    .request()
    .input('claim_token', sql.UniqueIdentifier, normalizedToken)
    .input('claimed_entra_object_id', sql.NVarChar(255), normalizedEntraObjectId)
    .input('claimed_email', sql.NVarChar(255), normalizedEmail)
    .query(
      `UPDATE identity_invite_claim
       SET claimed_at = COALESCE(claimed_at, GETUTCDATE()),
           claimed_entra_object_id = COALESCE(@claimed_entra_object_id, claimed_entra_object_id),
           claimed_email = COALESCE(@claimed_email, claimed_email),
           last_claimed_at = GETUTCDATE()
       WHERE claim_token = @claim_token`
    );

  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, claim.member_id)
    .input('entra_object_id', sql.NVarChar(255), normalizedEntraObjectId)
    .input('issuer', sql.NVarChar(255), normalizedIssuer)
    .input('issuer_assigned_id', sql.NVarChar(255), normalizedIssuerAssignedId)
    .input('identity_provider', sql.NVarChar(100), normalizedIdentityProvider)
    .input('last_seen_email', sql.NVarChar(255), normalizedEmail)
    .query(
      `MERGE member_identity_link AS target
       USING (SELECT @member_id AS member_id) AS source
       ON target.member_id = source.member_id
       WHEN MATCHED THEN
         UPDATE SET
           status = 'linked',
           linked_at = COALESCE(target.linked_at, GETUTCDATE()),
           last_sign_in_at = GETUTCDATE(),
           entra_object_id = COALESCE(@entra_object_id, target.entra_object_id),
           issuer = COALESCE(@issuer, target.issuer),
           issuer_assigned_id = COALESCE(@issuer_assigned_id, target.issuer_assigned_id),
           identity_provider = COALESCE(@identity_provider, target.identity_provider),
           last_seen_email = COALESCE(@last_seen_email, target.last_seen_email),
           updated_at = GETUTCDATE()
       WHEN NOT MATCHED THEN
         INSERT (
           link_id,
           member_id,
           entra_object_id,
           issuer,
           issuer_assigned_id,
           identity_provider,
           status,
           linked_at,
           last_sign_in_at,
           last_seen_email,
           created_at,
           updated_at
         )
         VALUES (
           NEWID(),
           @member_id,
           @entra_object_id,
           @issuer,
           @issuer_assigned_id,
           @identity_provider,
           'linked',
           GETUTCDATE(),
           GETUTCDATE(),
           @last_seen_email,
           GETUTCDATE(),
           GETUTCDATE()
         );`
    );

  return claim.member_id;
}

export function appendMemberInviteTokenToLoginUrl(loginUrl: string, memberInviteToken: string): string {
  const normalizedToken = normalizeMemberInviteToken(memberInviteToken);
  if (!normalizedToken) {
    return loginUrl;
  }

  try {
    const parsed = new URL(loginUrl);
    parsed.searchParams.set('invite', normalizedToken);
    return parsed.toString();
  } catch {
    return loginUrl;
  }
}