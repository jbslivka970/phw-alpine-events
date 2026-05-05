import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload, VerifyErrors } from 'jsonwebtoken';
import jwksRsa, { JwksClient } from 'jwks-rsa';
import { loadAuthConfig, loadEntraProvisioningConfig } from '../config';
import { getPool, sql } from '../db';
import { resolveRolesForRequest } from './authRoleResolver';
import { backfillAzureOidByEmail } from '../services/adminBootstrapService';

type AppRole = 'ADMIN' | 'EVENT_CREATOR' | 'USER' | 'TAVF_CREATOR';

interface AuthenticatedUser {
  sub: string;
  email?: string;
  name?: string;
  roles: AppRole[];
  rawClaims: JwtPayload;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

let jwksClient: JwksClient | null = null;
let authDiagnosticEventsEmitted = 0;

/**
 * Attempt to retrieve a user's email from Microsoft Graph using their Entra OID.
 * Uses the provisioning service-principal credentials (client_credentials grant).
 * Returns null if provisioning is not configured or the lookup fails.
 * Only called as a last resort when no email claim is present in the token.
 */
async function lookupEmailFromGraph(entraObjectId: string): Promise<string | null> {
  const cfg = loadEntraProvisioningConfig();
  if (!cfg.isConfigured) {
    return null;
  }

  try {
    const tokenParams = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenParams.toString() }
    );
    if (!tokenRes.ok) {
      return null;
    }
    const { access_token: graphToken } = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${entraObjectId}?$select=mail,otherMails,identities`,
      { headers: { Authorization: `Bearer ${graphToken}` } }
    );
    if (!userRes.ok) {
      return null;
    }

    const user = (await userRes.json()) as {
      mail?: string;
      otherMails?: string[];
      identities?: Array<{ issuer?: string; issuerAssignedId?: string }>;
    };

    // Prefer mail, then otherMails, then the identity issuerAssignedId that looks like an email.
    if (user.mail?.includes('@')) {
      return normalizeEmailLikeValue(user.mail) ?? user.mail.toLowerCase();
    }
    if (Array.isArray(user.otherMails)) {
      const found = user.otherMails.find((m) => typeof m === 'string' && m.includes('@'));
      if (found) {
        return normalizeEmailLikeValue(found) ?? found.toLowerCase();
      }
    }
    if (Array.isArray(user.identities)) {
      const found = user.identities.find(
        (id) => typeof id.issuerAssignedId === 'string' && id.issuerAssignedId.includes('@')
      );
      if (found?.issuerAssignedId) {
        return normalizeEmailLikeValue(found.issuerAssignedId) ?? found.issuerAssignedId.toLowerCase();
      }
    }
  } catch {
    // Non-fatal — auth continues without the email.
  }

  return null;
}

function authDiagnosticsEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env['AUTH_DIAGNOSTICS_ENABLED'] ?? '');
}

function authDiagnosticsMaxEvents(): number {
  const raw = process.env['AUTH_DIAGNOSTICS_MAX_EVENTS'];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildClaimSnapshot(claims: JwtPayload): Record<string, unknown> {
  const stringOrStringArray = (value: unknown): string | string[] | undefined => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    return undefined;
  };

  return {
    oid: stringOrStringArray(claims['oid']),
    sub: stringOrStringArray(claims['sub']),
    iss: stringOrStringArray(claims['iss']),
    aud: stringOrStringArray(claims['aud']),
    idp: stringOrStringArray(claims['idp']),
    email: stringOrStringArray(claims['email']),
    preferred_username: stringOrStringArray(claims['preferred_username']),
    upn: stringOrStringArray(claims['upn']),
    emails: stringOrStringArray(claims['emails']),
    otherMails: stringOrStringArray(claims['otherMails']),
    amr: stringOrStringArray(claims['amr']),
    roles: stringOrStringArray(claims['roles']),
    role: stringOrStringArray(claims['role']),
    extension_roles: stringOrStringArray(claims['extension_roles']),
    extension_role: stringOrStringArray(claims['extension_role']),
  };
}

function maybeEmitAuthDiagnostic(payload: {
  reason: string;
  email?: string;
  roles: AppRole[];
  linkedMemberId: string | null;
  uniqueMemberByEmail: string | null;
  matchCount: number;
  localPasswordBlocked: boolean;
  claims: JwtPayload;
}): void {
  if (!authDiagnosticsEnabled()) {
    return;
  }

  if (authDiagnosticEventsEmitted >= authDiagnosticsMaxEvents()) {
    return;
  }

  const targetEmail = (process.env['AUTH_DIAGNOSTICS_EMAIL'] ?? '').trim().toLowerCase();
  if (targetEmail && payload.email?.toLowerCase() !== targetEmail) {
    return;
  }

  authDiagnosticEventsEmitted += 1;
  console.warn('[auth][diagnostic]', {
    emittedAt: new Date().toISOString(),
    reason: payload.reason,
    email: payload.email,
    roles: payload.roles,
    linkedMemberId: payload.linkedMemberId,
    uniqueMemberByEmail: payload.uniqueMemberByEmail,
    matchCount: payload.matchCount,
    localPasswordBlocked: payload.localPasswordBlocked,
    claims: buildClaimSnapshot(payload.claims),
    emittedCount: authDiagnosticEventsEmitted,
    maxEvents: authDiagnosticsMaxEvents(),
  });
}

function getJwksClient(): JwksClient {
  const authConfig = loadAuthConfig();

  if (!jwksClient) {
    jwksClient = jwksRsa({
      jwksUri: authConfig.jwksUri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600_000,
      rateLimit: true,
    });
  }

  return jwksClient;
}

function getSigningKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  if (!header.kid) {
    callback(new Error('JWT header missing kid'), undefined);
    return;
  }

  getJwksClient().getSigningKey(header.kid, (error, key) => {
    if (error) {
      callback(error, undefined);
      return;
    }

    callback(null, key?.getPublicKey());
  });
}

function extractRoles(claims: JwtPayload): AppRole[] {
  const rawRoles: string[] = [];
  const normalizedRoles: AppRole[] = [];

  const normalizeRole = (value: string): AppRole | null => {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');

    if (normalized === 'ADMIN') {
      return 'ADMIN';
    }
    if (normalized === 'EVENT_CREATOR') {
      return 'EVENT_CREATOR';
    }
    if (normalized === 'USER') {
      return 'USER';
    }

    if (['ADMINISTRATOR', 'CHAPTER_ADMIN', 'SUPERADMIN', 'SUPER_ADMIN'].includes(normalized)) {
      return 'ADMIN';
    }

    if (['EVENTCREATOR', 'EVENT_MANAGER', 'EVENT_ADMIN'].includes(normalized)) {
      return 'EVENT_CREATOR';
    }

    if (['MEMBER', 'PARTICIPANT', 'READER'].includes(normalized)) {
      return 'USER';
    }

    if (['TAVFCREATOR', 'TAVF_GUIDE', 'GUIDE'].includes(normalized)) {
      return 'TAVF_CREATOR';
    }

    return null;
  };

  const pushClaimValues = (value: unknown): void => {
    if (typeof value === 'string') {
      rawRoles.push(...value.split(',').map((role) => role.trim()).filter(Boolean));
      return;
    }

    if (Array.isArray(value)) {
      rawRoles.push(...value.filter((role): role is string => typeof role === 'string').map((role) => role.trim()).filter(Boolean));
    }
  };

  pushClaimValues(claims['roles']);
  pushClaimValues(claims['role']);
  pushClaimValues(claims['extension_roles']);
  pushClaimValues(claims['extension_Roles']);
  pushClaimValues(claims['extension_role']);
  pushClaimValues(claims['extension_Role']);
  pushClaimValues(claims['appRoles']);
  pushClaimValues(claims['app_roles']);
  pushClaimValues(claims['groups']);

  for (const role of rawRoles) {
    const normalized = normalizeRole(role);
    if (normalized && !normalizedRoles.includes(normalized)) {
      normalizedRoles.push(normalized);
    }
  }

  return normalizedRoles;
}

function normalizeEmailLikeValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const extIndex = normalized.toLowerCase().indexOf('#ext#@');
  if (extIndex > 0) {
    const localAndDomain = normalized.slice(0, extIndex);
    const separatorIndex = localAndDomain.lastIndexOf('_');
    if (separatorIndex > 0 && separatorIndex < localAndDomain.length - 1) {
      const localPart = localAndDomain.slice(0, separatorIndex);
      const domainPart = localAndDomain.slice(separatorIndex + 1);
      if (localPart && domainPart) {
        return `${localPart}@${domainPart}`.toLowerCase();
      }
    }
  }

  if (normalized.includes('@')) {
    return normalized.toLowerCase();
  }

  return undefined;
}

function isTokenRoleFallbackEnabled(): boolean {
  const raw = process.env['AUTH_ALLOW_TOKEN_ROLE_FALLBACK'];
  if (raw && raw.trim().length > 0) {
    return /^(1|true|yes|on)$/i.test(raw);
  }

  // Default policy: in production the [user] table is the single source of
  // truth for authorization (token-claim roles are NOT trusted).  In any
  // other environment (dev / test / integration) we keep the permissive
  // fallback so local workflows and unit tests can mint synthetic tokens
  // without seeding the database.
  return (process.env['NODE_ENV'] ?? '').toLowerCase() !== 'production';
}

async function resolveAppAccountRole(claims: JwtPayload, email: string | undefined): Promise<string | null> {
  const oid = getStringClaim(claims, 'oid') ?? getStringClaim(claims, 'sub');
  const normalizedEmail = email?.trim().toLowerCase();

  if (!oid && !normalizedEmail) {
    return null;
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('oid', sql.NVarChar(255), oid ?? null)
      .input('email', sql.NVarChar(255), normalizedEmail ?? null)
      .query<{ role: string }>(
        `SELECT TOP 1 role
         FROM [user]
         WHERE is_active = 1
           AND (
             (@oid IS NOT NULL AND azure_oid = @oid)
             OR (@email IS NOT NULL AND LOWER(email) = @email)
           )
         ORDER BY CASE role
           WHEN 'superadmin' THEN 0
           WHEN 'admin' THEN 1
           WHEN 'event_creator' THEN 2
           WHEN 'tavf_creator' THEN 3
           WHEN 'user' THEN 4
           ELSE 9
         END`
      );

    const role = result.recordset[0]?.role ?? null;

    // Self-healing: if we matched by email but the row has no azure_oid yet,
    // backfill it now so future lookups resolve by OID (immune to email
    // casing/whitespace drift).  Fire-and-forget — do not block auth.
    if (role && oid && normalizedEmail) {
      void backfillAzureOidByEmail(normalizedEmail, oid);
    }

    return role;
  } catch (error) {
    // Do not fail auth if app role lookup cannot be completed.
    console.warn('[auth] app role lookup failed', error);
    return null;
  }
}

function extractEmail(claims: JwtPayload): string | undefined {
  const directClaims = ['email', 'preferred_username', 'upn'] as const;
  for (const claimName of directClaims) {
    const value = claims[claimName];
    if (typeof value === 'string' && value.trim().length > 0) {
      const normalized = normalizeEmailLikeValue(value);
      if (normalized) {
        return normalized;
      }
    }
  }

  const emailsClaim = claims['emails'];
  if (Array.isArray(emailsClaim)) {
    const first = emailsClaim.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (first) {
      const normalized = normalizeEmailLikeValue(first);
      if (normalized) {
        return normalized;
      }
    }
  }

  const otherMailsClaim = claims['otherMails'];
  if (Array.isArray(otherMailsClaim)) {
    const first = otherMailsClaim.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (first) {
      const normalized = normalizeEmailLikeValue(first);
      if (normalized) {
        return normalized;
      }
    }
  }

  // CIAM/social providers can emit non-standard claim names that include
  // email values (e.g. signInNames.emailAddress). Use a conservative fallback
  // by scanning string/array claims whose key names include "email".
  for (const [key, rawValue] of Object.entries(claims)) {
    if (!key.toLowerCase().includes('email')) {
      continue;
    }

    if (typeof rawValue === 'string') {
      const normalized = normalizeEmailLikeValue(rawValue);
      if (normalized) {
        return normalized;
      }
      continue;
    }

    if (Array.isArray(rawValue)) {
      const first = rawValue.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (first) {
        const normalized = normalizeEmailLikeValue(first);
        if (normalized) {
          return normalized;
        }
      }
    }
  }

  return undefined;
}

async function resolveUniqueActiveMemberByEmail(email: string | undefined): Promise<{ memberId: string | null; matchCount: number }> {
  if (!email) {
    return { memberId: null, matchCount: 0 };
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('email', sql.NVarChar, email.toLowerCase())
      .query<{ member_id: string }>(
        `SELECT TOP 2 member_id
         FROM member
         WHERE LOWER(email) = @email
           AND is_active = 1`
      );

    if (result.recordset.length !== 1) {
      return {
        memberId: null,
        matchCount: result.recordset.length,
      };
    }

    return {
      memberId: result.recordset[0]?.member_id ?? null,
      matchCount: 1,
    };
  } catch (error) {
    // Do not block auth on lookup failures; request falls back to claim-only roles.
    console.warn('[auth] member email fallback lookup failed', error);
    return { memberId: null, matchCount: 0 };
  }
}

async function resolveMemberIdByInvitedUserOid(entraObjectId: string | undefined): Promise<string | null> {
  if (!entraObjectId) {
    return null;
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('invited_user_id', sql.NVarChar(128), entraObjectId)
      .query<{ member_id: string }>(
        `IF OBJECT_ID('identity_invite_trace', 'U') IS NULL
         BEGIN
           SELECT TOP 0 CAST(NULL AS NVARCHAR(64)) AS member_id;
         END
         ELSE
         BEGIN
           SELECT TOP 1 member_id
           FROM identity_invite_trace
           WHERE invited_user_id = @invited_user_id
           ORDER BY occurred_at DESC;
         END`
      );

    const memberId = result.recordset[0]?.member_id;
    if (!memberId) {
      return null;
    }

    const activeMember = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ member_id: string }>(
        `SELECT TOP 1 member_id
         FROM member
         WHERE member_id = @member_id
           AND is_active = 1`
      );

    return activeMember.recordset[0]?.member_id ?? null;
  } catch (error) {
    console.warn('[auth] invited-user OID fallback lookup failed', error);
    return null;
  }
}

function getStringClaim(claims: JwtPayload, key: string): string | undefined {
  const value = claims[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseEmailAllowlist(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isEnabled(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}

function isLocalPasswordSignIn(claims: JwtPayload): boolean {
  const amrClaim = claims['amr'];
  const amrValues = (Array.isArray(amrClaim) ? amrClaim : [amrClaim])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());

  if (amrValues.includes('pwd')) {
    return true;
  }

  const idp = getStringClaim(claims, 'idp')?.toLowerCase();
  if (!idp) {
    return false;
  }

  if (idp.includes('google') || idp.includes('facebook') || idp.includes('microsoft')) {
    return false;
  }

  if (idp.includes('otp') || idp.includes('one-time') || idp.includes('email')) {
    return false;
  }

  return idp.includes('local') || idp.includes('account') || idp.includes('username');
}

function inferIdentityProvider(claims: JwtPayload): string {
  const idp = getStringClaim(claims, 'idp');
  if (idp) {
    return idp;
  }

  const issuer = getStringClaim(claims, 'iss')?.toLowerCase() ?? '';
  if (issuer.includes('google')) {
    return 'google';
  }
  if (issuer.includes('microsoft') || issuer.includes('ciamlogin') || issuer.includes('b2clogin')) {
    return 'microsoft';
  }

  return 'unknown';
}

async function upsertMemberIdentityLink(claims: JwtPayload, email: string | undefined): Promise<string | null> {
  const entraObjectId = getStringClaim(claims, 'oid') ?? getStringClaim(claims, 'sub');
  const issuer = getStringClaim(claims, 'iss');
  const issuerAssignedId = getStringClaim(claims, 'sub') ?? (email ? email.toLowerCase() : undefined);
  const identityProvider = inferIdentityProvider(claims);
  const normalizedEmail = email?.toLowerCase();

  if (!entraObjectId && !(issuer && issuerAssignedId) && !normalizedEmail) {
    return null;
  }

  const pool = await getPool();

  const existingLink = await pool
    .request()
    .input('entra_object_id', sql.NVarChar(255), entraObjectId ?? null)
    .input('issuer', sql.NVarChar(255), issuer ?? null)
    .input('issuer_assigned_id', sql.NVarChar(255), issuerAssignedId ?? null)
    .input('normalized_email', sql.NVarChar(255), normalizedEmail ?? null)
    .query<{ member_id: string }>(
      `SELECT TOP 1 member_id
       FROM member_identity_link mil
       INNER JOIN member m ON m.member_id = mil.member_id
        WHERE (
            (@entra_object_id IS NOT NULL AND entra_object_id = @entra_object_id)
            OR (@issuer IS NOT NULL AND @issuer_assigned_id IS NOT NULL AND issuer = @issuer AND issuer_assigned_id = @issuer_assigned_id)
            OR (@normalized_email IS NOT NULL AND (LOWER(mil.last_seen_email) = @normalized_email OR LOWER(m.email) = @normalized_email))
           )
          AND m.is_active = 1`
    );

  const linkedMemberId = existingLink.recordset[0]?.member_id;
  if (linkedMemberId) {
    await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, linkedMemberId)
      .input('entra_object_id', sql.NVarChar(255), entraObjectId ?? null)
      .input('issuer', sql.NVarChar(255), issuer ?? null)
      .input('issuer_assigned_id', sql.NVarChar(255), issuerAssignedId ?? null)
      .input('identity_provider', sql.NVarChar(100), identityProvider)
      .input('last_seen_email', sql.NVarChar(255), normalizedEmail ?? null)
      .query(
        `UPDATE member_identity_link
         SET status = 'linked',
             linked_at = COALESCE(linked_at, GETUTCDATE()),
             last_sign_in_at = GETUTCDATE(),
             entra_object_id = COALESCE(@entra_object_id, entra_object_id),
             issuer = COALESCE(@issuer, issuer),
             issuer_assigned_id = COALESCE(@issuer_assigned_id, issuer_assigned_id),
             identity_provider = COALESCE(@identity_provider, identity_provider),
             last_seen_email = COALESCE(@last_seen_email, last_seen_email),
             updated_at = GETUTCDATE()
         WHERE member_id = @member_id`
      );

    return linkedMemberId;
  }

  // No existing link found. If we have no email from the token, attempt a one-time Graph API
  // lookup using the Entra OID so that Google-federated CIAM users whose access tokens omit
  // the email claim can still be auto-linked on their very first sign-in.
  let resolvedEmail = normalizedEmail;
  if (!resolvedEmail && entraObjectId) {
    const graphEmail = await lookupEmailFromGraph(entraObjectId).catch(() => null);
    if (graphEmail) {
      console.info('[auth] email resolved via Graph API fallback for unlinked OID', {
        oid: entraObjectId,
        email: graphEmail,
      });
      resolvedEmail = graphEmail;
    }
  }

  let matchedMemberId: string | null = null;
  let matchCount = 0;

  if (resolvedEmail) {
    const resolvedByEmail = await resolveUniqueActiveMemberByEmail(resolvedEmail);
    matchedMemberId = resolvedByEmail.memberId;
    matchCount = resolvedByEmail.matchCount;
  }

  if (matchCount > 1) {
    console.warn('[auth] duplicate active member email detected; refusing auto-link', {
      email: resolvedEmail,
      matchCount,
    });
  }

  if (!matchedMemberId && matchCount === 0 && !resolvedEmail && entraObjectId) {
    matchedMemberId = await resolveMemberIdByInvitedUserOid(entraObjectId);
    if (matchedMemberId) {
      matchCount = 1;
    }
  }

  if (!matchedMemberId) {
    return null;
  }

  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, matchedMemberId)
    .input('entra_object_id', sql.NVarChar(255), entraObjectId ?? null)
    .input('issuer', sql.NVarChar(255), issuer ?? null)
    .input('issuer_assigned_id', sql.NVarChar(255), issuerAssignedId ?? null)
    .input('identity_provider', sql.NVarChar(100), identityProvider)
    .input('last_seen_email', sql.NVarChar(255), resolvedEmail ?? null)
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
           link_id, member_id, entra_object_id, issuer, issuer_assigned_id, identity_provider,
           status, linked_at, last_sign_in_at, last_seen_email, created_at, updated_at
         )
         VALUES (
           NEWID(), @member_id, @entra_object_id, @issuer, @issuer_assigned_id, @identity_provider,
           'linked', GETUTCDATE(), GETUTCDATE(), @last_seen_email, GETUTCDATE(), GETUTCDATE()
         );`
    );

  return matchedMemberId;
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authConfig = loadAuthConfig();

  // In test mode, bypass JWT validation and inject a default test user
  if (process.env.NODE_ENV === 'test') {
    req.user = {
      sub: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      roles: ['ADMIN'],
      rawClaims: {},
    };
    next();
    return;
  }

  const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env['E2E_LOCAL_AUTH_ENABLED'] ?? '');
  if (localE2EAuthEnabled && process.env.NODE_ENV === 'production') {
    console.error('[auth] E2E_LOCAL_AUTH_ENABLED is not allowed in production.');
    res.status(503).json({ error: 'Local E2E auth bypass is disabled in production.' });
    return;
  }

  if (localE2EAuthEnabled) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim().toLowerCase();
    const roleByToken: Record<string, AppRole[]> = {
      'e2e-admin': ['ADMIN', 'EVENT_CREATOR', 'USER', 'TAVF_CREATOR'],
      'e2e-event_creator': ['EVENT_CREATOR', 'USER', 'TAVF_CREATOR'],
      'e2e-user': ['USER', 'TAVF_CREATOR'],
      'e2e-tavf_creator': ['TAVF_CREATOR', 'USER'],
    };
    const roles = roleByToken[token];

    if (!roles) {
      res.status(401).json({ error: 'Invalid local E2E token' });
      return;
    }

    req.user = {
      sub: token,
      email: `${token}@local.e2e`,
      name: token,
      roles,
      rawClaims: {
        sub: token,
        email: `${token}@local.e2e`,
        roles,
      },
    };
    next();
    return;
  }

  if (!authConfig.isConfigured) {
    res.status(503).json({ error: 'Authentication is not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  jwt.verify(
    token,
    getSigningKey,
    {
      algorithms: ['RS256'],
      audience: authConfig.clientId,
      issuer: authConfig.issuer,
    },
    async (error: VerifyErrors | null, decoded) => {
      if (error || !decoded) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }

      const claims = decoded as JwtPayload;
      let emailClaim = extractEmail(claims);

      // CIAM access tokens for custom API audiences may not contain email claims.
      // Fall back to the X-Id-Token-Email header sent by the frontend from the
      // id_token which does include the email.
      if (!emailClaim) {
        const headerEmail = req.headers['x-id-token-email'];
        if (typeof headerEmail === 'string' && headerEmail.includes('@')) {
          emailClaim = normalizeEmailLikeValue(headerEmail) ?? headerEmail.trim().toLowerCase();
          console.info('[auth] email resolved from X-Id-Token-Email header (not in access token)', {
            email: emailClaim,
            oid: claims['oid'] ?? claims['sub'],
          });
        }
      }

      const roles = extractRoles(claims);
      const normalizedEmail = emailClaim?.toLowerCase();

      const enforceMemberPasswordless = isEnabled(process.env['AUTH_ENFORCE_MEMBER_PASSWORDLESS'], true);
      const localPasswordAllowlist = parseEmailAllowlist(process.env['AUTH_LOCAL_PASSWORD_ALLOWLIST']);
      if (enforceMemberPasswordless && isLocalPasswordSignIn(claims)) {
        const isAllowlisted = normalizedEmail ? localPasswordAllowlist.has(normalizedEmail) : false;
        if (!isAllowlisted) {
          maybeEmitAuthDiagnostic({
            reason: 'local_password_blocked',
            email: emailClaim,
            roles,
            linkedMemberId: null,
            uniqueMemberByEmail: null,
            matchCount: 0,
            localPasswordBlocked: true,
            claims,
          });
          res.status(403).json({
            error: 'Local password sign-in is disabled for members. Use Google, Microsoft, Meta, or email OTP.',
          });
          return;
        }
      }

      let linkedMemberId: string | null = null;
      try {
        linkedMemberId = await upsertMemberIdentityLink(claims, emailClaim);
      } catch (linkError) {
        // Keep auth resilient if identity link table is not yet deployed or temporarily unavailable.
        console.warn('[auth] member identity link lookup failed', linkError);
      }

      const { memberId: uniqueMemberByEmail, matchCount } = await resolveUniqueActiveMemberByEmail(emailClaim);
      if (matchCount > 1) {
        console.warn('[auth] duplicate active member email detected; suppressing implicit USER role', {
          email: emailClaim,
          matchCount,
        });
      }

      const appAccountRole = await resolveAppAccountRole(claims, emailClaim);
      const allowTokenRoleFallback = isTokenRoleFallbackEnabled();
      const resolvedRoles = resolveRolesForRequest({
        appAccountRole,
        linkedMemberId,
        uniqueMemberByEmail,
        tokenRoles: roles,
        allowTokenRoleFallback,
      });

      if (resolvedRoles.length === 0) {
        maybeEmitAuthDiagnostic({
          reason: 'no_roles_after_member_resolution',
          email: emailClaim,
          roles: resolvedRoles,
          linkedMemberId,
          uniqueMemberByEmail,
          matchCount,
          localPasswordBlocked: false,
          claims,
        });
      }

      req.user = {
        sub: String(claims['oid'] ?? claims['sub'] ?? ''),
        email: emailClaim,
        name: typeof claims['name'] === 'string' ? claims['name'] : undefined,
        roles: resolvedRoles,
        rawClaims: claims,
      };

      next();
    }
  );
}

export default authenticate;
export type { AppRole, AuthenticatedUser };