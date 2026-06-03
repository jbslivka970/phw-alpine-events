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
  grantTenantMembershipByEmail,
  getTenantUsageSummary,
  grantDemoAccessByEmail,
  grantTenantAdminByEmail,
  listDemoAccessMemberships,
  listTenantMemberships,
  listTenantAdmins,
  resetAndReseedDemoTenant,
  revokeTenantAdminByUserId,
  setTenantStatus,
  updateTenantMembership,
  revokeDemoAccessMembership,
} from '../services/tenantService';
import {
  getTenantMessaging,
  upsertTenantMessaging,
  type SmsProvider,
} from '../services/rootTenantMessagingService';

const router = Router();

const APP_ROLES: AppUserRole[] = ['admin', 'superadmin', 'event_creator', 'tavf_creator', 'user'];
const ROOT_ROLES: RootRole[] = ['root_admin', 'support'];
const TENANT_ROLES: TenantMembershipRole[] = ['member', 'admin', 'event_creator', 'tavf_creator', 'support', 'root_admin'];
const MEMBERSHIP_KINDS: TenantMembershipKind[] = ['home', 'temporary_demo', 'admin'];
const MEMBERSHIP_STATUSES = ['active', 'revoked'] as const;
const PERSONAS: MemberPersona[] = ['participant', 'volunteer', 'mentor', 'guide', 'staff'];
const BRANDING_ASSET_KINDS: TenantBrandingAssetKind[] = ['logo', 'logo_dark', 'hero'];
const SMS_PROVIDERS: Array<Exclude<SmsProvider, null>> = ['acs', 'twilio', 'telnyx'];
const TENANT_STATUSES = ['active', 'suspended'] as const;

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

router.delete('/tenants/:tenantId/admins/:userId', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const userId = String(req.params.userId ?? '').trim();

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!isValidGuid(userId)) {
      res.status(400).json({ error: 'userId must be a valid UUID' });
      return;
    }

    const admins = await revokeTenantAdminByUserId(tenantId, userId);
    res.json({ admins });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke tenant admin';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    next(error);
  }
});

router.post('/tenants/:tenantId/suspend', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const requestedAction = typeof req.body?.action === 'string' ? req.body.action.trim().toLowerCase() : 'suspend';
    const suspend = requestedAction !== 'reactivate';

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!['suspend', 'reactivate'].includes(requestedAction)) {
      res.status(400).json({ error: 'action must be either suspend or reactivate' });
      return;
    }

    const tenant = await setTenantStatus(tenantId, suspend ? TENANT_STATUSES[1] : TENANT_STATUSES[0]);
    res.json({ tenant, action: suspend ? 'suspend' : 'reactivate' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update tenant status';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get('/tenants/:tenantId/usage', async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const usage = await getTenantUsageSummary(tenantId);
    res.json(usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load tenant usage';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get('/tenants/:tenantId/memberships', async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const memberships = await listTenantMemberships(tenantId);
    res.json({ memberships });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load tenant memberships';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    next(error);
  }
});

router.post('/tenants/:tenantId/memberships', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : null;
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() as TenantMembershipRole : null;
    const membershipKind = typeof req.body?.membership_kind === 'string'
      ? req.body.membership_kind.trim().toLowerCase() as TenantMembershipKind
      : null;
    const expiresAt = typeof req.body?.expires_at === 'string' && req.body.expires_at.trim().length > 0
      ? req.body.expires_at.trim()
      : null;

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (!role || !TENANT_ROLES.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${TENANT_ROLES.join(', ')}` });
      return;
    }
    if (!membershipKind || !MEMBERSHIP_KINDS.includes(membershipKind)) {
      res.status(400).json({ error: `membership_kind must be one of: ${MEMBERSHIP_KINDS.join(', ')}` });
      return;
    }

    const memberships = await grantTenantMembershipByEmail({
      tenantId,
      email,
      displayName,
      actorEmail: req.user?.email ?? null,
      role,
      membershipKind,
      expiresAt,
    });

    res.json({ memberships });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to grant tenant membership';
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

router.patch('/tenants/:tenantId/memberships/:membershipId', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const membershipId = String(req.params.membershipId ?? '').trim();
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() as TenantMembershipRole : undefined;
    const membershipKind = typeof req.body?.membership_kind === 'string'
      ? req.body.membership_kind.trim().toLowerCase() as TenantMembershipKind
      : undefined;
    const status = typeof req.body?.status === 'string'
      ? req.body.status.trim().toLowerCase()
      : undefined;
    const hasExpiresAtField = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expires_at');
    const expiresAt = hasExpiresAtField
      ? (typeof req.body?.expires_at === 'string' ? req.body.expires_at.trim() : null)
      : undefined;

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!isValidGuid(membershipId)) {
      res.status(400).json({ error: 'membershipId must be a valid UUID' });
      return;
    }
    if (role && !TENANT_ROLES.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${TENANT_ROLES.join(', ')}` });
      return;
    }
    if (membershipKind && !MEMBERSHIP_KINDS.includes(membershipKind)) {
      res.status(400).json({ error: `membership_kind must be one of: ${MEMBERSHIP_KINDS.join(', ')}` });
      return;
    }
    if (status && !MEMBERSHIP_STATUSES.includes(status as (typeof MEMBERSHIP_STATUSES)[number])) {
      res.status(400).json({ error: `status must be one of: ${MEMBERSHIP_STATUSES.join(', ')}` });
      return;
    }
    if (!role && !membershipKind && !status && expiresAt === undefined) {
      res.status(400).json({ error: 'At least one field must be provided: role, membership_kind, status, expires_at' });
      return;
    }

    const memberships = await updateTenantMembership(tenantId, membershipId, {
      role,
      membershipKind,
      status: status as 'active' | 'revoked' | undefined,
      expiresAt: expiresAt === undefined ? undefined : (expiresAt || null),
    });

    res.json({ memberships });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update tenant membership';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes('valid')) {
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get('/tenants/:tenantId/messaging', async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const messaging = await getTenantMessaging(tenantId);
    if (!messaging) {
      res.status(404).json({ error: 'Tenant messaging not found' });
      return;
    }

    res.json(messaging);
  } catch (error) {
    next(error);
  }
});

router.put('/tenants/:tenantId/messaging', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const smsProvider = req.body?.sms_provider == null
      ? null
      : String(req.body.sms_provider).trim().toLowerCase() as SmsProvider;
    if (smsProvider && !SMS_PROVIDERS.includes(smsProvider as Exclude<SmsProvider, null>)) {
      res.status(400).json({ error: `sms_provider must be one of: ${SMS_PROVIDERS.join(', ')}` });
      return;
    }

    const messaging = await upsertTenantMessaging({
      tenantId,
      email_from: req.body?.email_from,
      email_reply_to: req.body?.email_reply_to,
      email_bcc_monitor: req.body?.email_bcc_monitor,
      sms_provider: smsProvider,
      sms_from: req.body?.sms_from,
      twilio_messaging_service_sid: req.body?.twilio_messaging_service_sid,
      telnyx_messaging_profile_id: req.body?.telnyx_messaging_profile_id,
      telnyx_from_number: req.body?.telnyx_from_number,
    });

    res.json(messaging);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save tenant messaging';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes('must be')) {
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get('/tenants/:tenantId/demo/memberships', async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const memberships = await listDemoAccessMemberships(tenantId);
    res.json({ memberships });
  } catch (error) {
    next(error);
  }
});

router.post('/tenants/:tenantId/demo/memberships', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : null;
    const expiresAt = typeof req.body?.expires_at === 'string' ? req.body.expires_at.trim() : '';

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (!expiresAt) {
      res.status(400).json({ error: 'expires_at is required' });
      return;
    }

    const memberships = await grantDemoAccessByEmail({
      tenantId,
      email,
      displayName,
      actorEmail: req.user?.email ?? null,
      expiresAt,
    });

    res.json({ memberships });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to grant demo access';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes('not a demo tenant')) {
      res.status(409).json({ error: message });
      return;
    }
    if (message.includes('required') || message.includes('valid') || message.includes('future')) {
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.delete('/tenants/:tenantId/demo/memberships/:membershipId', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const membershipId = String(req.params.membershipId ?? '').trim();

    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }
    if (!isValidGuid(membershipId)) {
      res.status(400).json({ error: 'membershipId must be a valid UUID' });
      return;
    }

    const memberships = await revokeDemoAccessMembership(tenantId, membershipId);
    res.json({ memberships });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke demo access';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes('not a demo tenant')) {
      res.status(409).json({ error: message });
      return;
    }
    next(error);
  }
});

router.post('/tenants/:tenantId/demo/reset', writeLimiter, async (req, res, next) => {
  try {
    const tenantId = String(req.params.tenantId ?? '').trim();
    const reseed = req.body?.reseed == null ? true : Boolean(req.body.reseed);
    if (!isValidGuid(tenantId)) {
      res.status(400).json({ error: 'tenantId must be a valid UUID' });
      return;
    }

    const resetResult = await resetAndReseedDemoTenant(tenantId, { reseed });
    res.json(resetResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reset demo memberships';
    if (message.includes('Tenant not found')) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes('not a demo tenant')) {
      res.status(409).json({ error: message });
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
    const hasTenantMembershipsField = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'tenant_memberships');
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

    if (hasTenantMembershipsField) {
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
      tenant_memberships: hasTenantMembershipsField ? normalizedMemberships : undefined,
      updated_by_email: req.user?.email ?? email,
    });

    res.json(profile);
  } catch (error) {
    next(error);
  }
});

export default router;
