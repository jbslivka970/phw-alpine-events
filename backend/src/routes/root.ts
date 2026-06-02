import { Router, type Response } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireRoot } from '../middleware/requireRoot';
import {
  getRootAccessProfileByEmail,
  getRootSession,
  listTenantsForRoot,
  upsertRootAccessProfile,
  type AppUserRole,
  type MemberPersona,
  type RootRole,
  type TenantMembershipKind,
  type TenantMembershipRole,
} from '../services/rootAccessService';
import {
  commitBrandingAsset,
  createBrandingAssetUploadUrl,
  getTenantBranding,
  upsertTenantBranding,
  type TenantBrandingAssetKind,
} from '../services/rootTenantBrandingService';
import {
  createTenant,
  grantTenantAdminByEmail,
  listTenantAdmins,
} from '../services/tenantService';

const router = Router();

const APP_ROLES: AppUserRole[] = ['admin', 'superadmin', 'event_creator', 'tavf_creator', 'user'];
const ROOT_ROLES: RootRole[] = ['root_admin', 'support'];
const TENANT_ROLES: TenantMembershipRole[] = ['member', 'admin', 'event_creator', 'tavf_creator', 'support', 'root_admin'];
const MEMBERSHIP_KINDS: TenantMembershipKind[] = ['home', 'temporary_demo', 'admin'];
const PERSONAS: MemberPersona[] = ['participant', 'volunteer', 'mentor', 'guide', 'staff'];
const BRANDING_ASSET_KINDS: TenantBrandingAssetKind[] = ['logo', 'logo_dark', 'hero'];

function isValidGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function sendBrandingServiceError(res: Response, error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Tenant not found') {
    res.status(404).json({ error: message });
    return true;
  }
  if (message.includes('Only image uploads are allowed')
    || message.includes('assetUrl is required')
    || message.includes('assetUrl does not belong')) {
    res.status(400).json({ error: message });
    return true;
  }
  if (message.includes('Blob storage credentials are not configured')) {
    res.status(503).json({ error: message });
    return true;
  }
  return false;
}

router.use(apiLimiter, authenticate, requireRoot);

router.get('/session', async (req, res, next) => {
  try {
    const session = await getRootSession({ sub: req.user?.sub, email: req.user?.email });
    if (!session) {
      res.status(404).json({ error: 'Root session not found' });
      return;
    }
    res.json(session);
  } catch (error) {
    if (sendBrandingServiceError(res, error)) {
      return;
    }
    next(error);
  }
});

router.get('/tenants', async (_req, res, next) => {
  try {
    const tenants = await listTenantsForRoot();
    res.json({ tenants });
  } catch (error) {
    if (sendBrandingServiceError(res, error)) {
      return;
    }
    next(error);
  }
});

router.post('/tenants', writeLimiter, async (req, res, next) => {
  try {
    const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    const tenantType = typeof req.body?.tenant_type === 'string' ? req.body.tenant_type.trim().toLowerCase() : undefined;
    const status = typeof req.body?.status === 'string' ? req.body.status.trim().toLowerCase() : undefined;
    const timezone = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : undefined;
    const isDemo = req.body?.is_demo == null ? undefined : Boolean(req.body.is_demo);
    const isOperational = req.body?.is_operational == null ? undefined : Boolean(req.body.is_operational);

    if (!slug) {
      res.status(400).json({ error: 'slug is required' });
      return;
    }
    if (!displayName) {
      res.status(400).json({ error: 'display_name is required' });
      return;
    }

    const tenant = await createTenant({
      slug,
      displayName,
      tenantType: tenantType as 'program' | 'demo' | 'system' | undefined,
      status: status as 'active' | 'suspended' | 'archived' | undefined,
      timezone,
      isDemo,
      isOperational,
    });

    res.status(201).json(tenant);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create tenant';
    if (message.includes('already exists')) {
      res.status(409).json({ error: message });
      return;
    }
    if (message.includes('required')) {
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get('/tenants/:tenantId/admins', async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    const admins = await listTenantAdmins(tenantId);
    res.json({ admins });
  } catch (error) {
    next(error);
  }
});

router.post('/tenants/:tenantId/admins', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : null;
    const expiresAt = typeof req.body?.expires_at === 'string' ? req.body.expires_at.trim() : null;

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }

    const admins = await grantTenantAdminByEmail({
      tenantId,
      email,
      displayName,
      actorEmail: req.user?.email ?? null,
      expiresAt,
    });

    res.json({ admins });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to grant tenant admin';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes('required') || message.includes('valid')) {
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get('/tenants/:tenantId/branding', async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const branding = await getTenantBranding(tenantId);
    if (!branding) {
      res.status(404).json({ error: 'Tenant branding not found' });
      return;
    }

    res.json(branding);
  } catch (error) {
    if (sendBrandingServiceError(res, error)) {
      return;
    }
    next(error);
  }
});

router.put('/tenants/:tenantId/branding', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const heroImageUrls = Array.isArray(req.body?.hero_image_urls)
      ? req.body.hero_image_urls.map((value: unknown) => String(value).trim()).filter((value: string) => value.length > 0)
      : undefined;

    const branding = await upsertTenantBranding({
      tenantId,
      org_long_name: req.body?.org_long_name,
      org_short_name: req.body?.org_short_name,
      support_email: req.body?.support_email,
      accessibility_email: req.body?.accessibility_email,
      logo_url: req.body?.logo_url,
      logo_dark_url: req.body?.logo_dark_url,
      hero_image_urls: heroImageUrls,
      primary_color: req.body?.primary_color,
      accent_color: req.body?.accent_color,
      dark_color: req.body?.dark_color,
      program_tagline: req.body?.program_tagline,
      portal_login_url: req.body?.portal_login_url,
      mission_blurb: req.body?.mission_blurb,
    });

    res.json(branding);
  } catch (error) {
    if (sendBrandingServiceError(res, error)) {
      return;
    }
    next(error);
  }
});

router.post('/tenants/:tenantId/branding/assets/upload-url', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const fileName = typeof req.body?.file_name === 'string' ? req.body.file_name.trim() : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type.trim() : '';
    const assetKind = typeof req.body?.asset_kind === 'string'
      ? req.body.asset_kind.trim().toLowerCase() as TenantBrandingAssetKind
      : null;

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!fileName) {
      res.status(400).json({ error: 'file_name is required' });
      return;
    }
    if (!contentType) {
      res.status(400).json({ error: 'content_type is required' });
      return;
    }
    if (!assetKind || !BRANDING_ASSET_KINDS.includes(assetKind)) {
      res.status(400).json({ error: `asset_kind must be one of: ${BRANDING_ASSET_KINDS.join(', ')}` });
      return;
    }

    const upload = await createBrandingAssetUploadUrl({
      tenantId,
      fileName,
      contentType,
      assetKind,
    });

    res.json(upload);
  } catch (error) {
    next(error);
  }
});

router.post('/tenants/:tenantId/branding/assets/commit', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const assetUrl = typeof req.body?.asset_url === 'string' ? req.body.asset_url.trim() : '';
    const assetKind = typeof req.body?.asset_kind === 'string'
      ? req.body.asset_kind.trim().toLowerCase() as TenantBrandingAssetKind
      : null;

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!assetUrl) {
      res.status(400).json({ error: 'asset_url is required' });
      return;
    }
    if (!assetKind || !BRANDING_ASSET_KINDS.includes(assetKind)) {
      res.status(400).json({ error: `asset_kind must be one of: ${BRANDING_ASSET_KINDS.join(', ')}` });
      return;
    }

    const branding = await commitBrandingAsset({
      tenantId,
      assetKind,
      assetUrl,
    });

    res.json(branding);
  } catch (error) {
    next(error);
  }
});

router.get('/access', async (req, res, next) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'email query parameter is required' });
      return;
    }
    const profile = await getRootAccessProfileByEmail(email);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

router.put('/access', writeLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const appRole = typeof req.body?.app_role === 'string' ? req.body.app_role.trim().toLowerCase() as AppUserRole : null;
    const isRoot = Boolean(req.body?.is_root);
    const rootRole = req.body?.root_role == null ? null : String(req.body.root_role).trim().toLowerCase() as RootRole;
    const displayName = req.body?.display_name == null ? null : String(req.body.display_name);
    const firstName = req.body?.first_name == null ? null : String(req.body.first_name);
    const lastName = req.body?.last_name == null ? null : String(req.body.last_name);
    const ensureMember = Boolean(req.body?.ensure_member);
    const personas = Array.isArray(req.body?.personas)
      ? req.body.personas.map((value: unknown) => String(value).trim().toLowerCase()) as MemberPersona[]
      : [];
    const tenantMemberships = Array.isArray(req.body?.tenant_memberships) ? req.body.tenant_memberships : [];

    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!appRole || !APP_ROLES.includes(appRole)) {
      res.status(400).json({ error: `app_role must be one of: ${APP_ROLES.join(', ')}` });
      return;
    }
    if (rootRole && !ROOT_ROLES.includes(rootRole)) {
      res.status(400).json({ error: `root_role must be one of: ${ROOT_ROLES.join(', ')}` });
      return;
    }
    if (personas.some((persona) => !PERSONAS.includes(persona))) {
      res.status(400).json({ error: `personas must only include: ${PERSONAS.join(', ')}` });
      return;
    }

    const normalizedMemberships = tenantMemberships.map((membership: unknown) => ({
      tenant_id: typeof (membership as { tenant_id?: unknown }).tenant_id === 'string' ? (membership as { tenant_id: string }).tenant_id.trim() : '',
      role: typeof (membership as { role?: unknown }).role === 'string' ? (membership as { role: string }).role.trim().toLowerCase() as TenantMembershipRole : null,
      membership_kind: typeof (membership as { membership_kind?: unknown }).membership_kind === 'string'
        ? (membership as { membership_kind: string }).membership_kind.trim().toLowerCase() as TenantMembershipKind
        : null,
      expires_at: typeof (membership as { expires_at?: unknown }).expires_at === 'string' && (membership as { expires_at: string }).expires_at.trim().length > 0
        ? (membership as { expires_at: string }).expires_at.trim()
        : null,
    }));

    for (const membership of normalizedMemberships) {
      if (!membership.tenant_id) {
        res.status(400).json({ error: 'tenant_memberships[].tenant_id is required' });
        return;
      }
      if (!membership.role || !TENANT_ROLES.includes(membership.role)) {
        res.status(400).json({ error: `tenant membership role must be one of: ${TENANT_ROLES.join(', ')}` });
        return;
      }
      if (!membership.membership_kind || !MEMBERSHIP_KINDS.includes(membership.membership_kind)) {
        res.status(400).json({ error: `membership_kind must be one of: ${MEMBERSHIP_KINDS.join(', ')}` });
        return;
      }
    }

    const profile = await upsertRootAccessProfile({
      email,
      display_name: displayName,
      app_role: appRole,
      is_root: isRoot,
      root_role: rootRole,
      ensure_member: ensureMember,
      first_name: firstName,
      last_name: lastName,
      personas,
      tenant_memberships: normalizedMemberships,
      updated_by_email: req.user?.email ?? email,
    });

    res.json(profile);
  } catch (error) {
    next(error);
  }
});

export default router;
