import { Router } from 'express';
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

const router = Router();

const APP_ROLES: AppUserRole[] = ['admin', 'superadmin', 'event_creator', 'tavf_creator', 'user'];
const ROOT_ROLES: RootRole[] = ['root_admin', 'support'];
const TENANT_ROLES: TenantMembershipRole[] = ['member', 'admin', 'event_creator', 'tavf_creator', 'support', 'root_admin'];
const MEMBERSHIP_KINDS: TenantMembershipKind[] = ['home', 'temporary_demo', 'admin'];
const PERSONAS: MemberPersona[] = ['participant', 'volunteer', 'mentor', 'guide', 'staff'];

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
    next(error);
  }
});

router.get('/tenants', async (_req, res, next) => {
  try {
    const tenants = await listTenantsForRoot();
    res.json({ tenants });
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
