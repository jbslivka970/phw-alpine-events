import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin, requireAnyAuthenticatedRole } from '../middleware/rbac';
import { getMemberGroups } from '../services/groupService';
import { notificationService } from '../services/notifications';
import { toE164 } from '../utils/phone';
import {
  createMember,
  deactivateMember,
  getMemberById,
  hardDeleteMember,
  listMembers,
  updateMember,
} from '../services/memberService';
import {
  SUPPORTED_PERSONAS,
  listPersonasForMember,
  normalizePersona,
  setPersonasForMember,
  type Persona,
} from '../services/personaService';
import { withShortLivedCache } from '../services/shortLivedCache';

const router = Router();

type SmsRolloutReason =
  | 'open_rollout'
  | 'email_allowlist'
  | 'group_allowlist'
  | 'not_in_rollout_cohort'
  | 'missing_member_email';

interface SmsRolloutStatus {
  enabled: boolean;
  reason: SmsRolloutReason;
  configuredEmails: string[];
  configuredGroups: string[];
  matchedGroups: string[];
}

function parsePositiveIntQuery(value: unknown, max: number): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.min(parsed, max);
}

const DASHBOARD_CACHE_TTL_MS = 20_000;

router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const pageSize = parseInt((req.query.pageSize as string) ?? '50', 10);
    const search = (req.query.search as string) || undefined;
    const isActiveRaw = req.query.isActive as string | undefined;
    const isActive = isActiveRaw === undefined ? undefined : isActiveRaw !== 'false';

    const result = await listMembers({ page, pageSize, search, isActive });
    res.json({ ...result, page, pageSize });
  } catch (error) {
    next(error);
  }
});

router.get('/me', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const memberId = await resolveSelfMemberId(req.user?.sub, req.user?.email, req.user?.rawClaims);
    if (!memberId) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    const member = await getMemberById(memberId);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    const personas = await listPersonasForMember(memberId);

    res.json({
      ...member,
      auth_roles: req.user?.roles ?? [],
      personas,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/me/phone', writeLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const memberId = await resolveSelfMemberId(req.user?.sub, req.user?.email, req.user?.rawClaims);
    if (!memberId) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    const phoneInput = req.body?.mobile_phone;
    if (phoneInput !== undefined && phoneInput !== null && typeof phoneInput !== 'string') {
      res.status(400).json({ error: 'mobile_phone must be a string or null.' });
      return;
    }

    const normalizedPhone = toE164(phoneInput ?? null);
    if (phoneInput && !normalizedPhone) {
      res.status(400).json({ error: 'Please enter a valid US phone number.' });
      return;
    }

    const updated = await updateMember(memberId, { mobile_phone: normalizedPhone });
    if (!updated) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Personas (orthogonal to [user].role; describe what a member signs up for).
// Read: any authenticated role (or self).  Write: admin only.
// ---------------------------------------------------------------------------

router.get(
  '/:id/personas',
  apiLimiter,
  authenticate,
  requireAnyAuthenticatedRole,
  async (req, res, next) => {
    try {
      const personas = await listPersonasForMember(req.params.id);
      res.json({ personas, supported: SUPPORTED_PERSONAS });
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  '/:id/personas',
  writeLimiter,
  authenticate,
  requireAdmin,
  async (req, res, next) => {
    try {
      const raw = (req.body && Array.isArray((req.body as { personas?: unknown }).personas))
        ? (req.body as { personas: unknown[] }).personas
        : null;
      if (!raw) {
        res.status(400).json({ error: 'Body must include "personas": string[]' });
        return;
      }

      const normalized: Persona[] = [];
      const invalid: unknown[] = [];
      for (const value of raw) {
        const persona = normalizePersona(value);
        if (persona) normalized.push(persona);
        else invalid.push(value);
      }
      if (invalid.length > 0) {
        res.status(400).json({
          error: 'Invalid persona value(s).',
          invalid,
          supported: SUPPORTED_PERSONAS,
        });
        return;
      }

      // granted_by is recorded only when the caller has a [user] row
      // (best-effort lookup by email).  If unavailable we record null.
      let grantedByUserId: string | null = null;
      const callerEmail = req.user?.email?.trim().toLowerCase();
      if (callerEmail) {
        try {
          const pool = await getPool();
          const lookup = await pool
            .request()
            .input('email', sql.NVarChar(255), callerEmail)
            .query<{ user_id: string }>(
              `SELECT TOP 1 user_id FROM dbo.[user]
               WHERE LOWER(email) = @email AND is_active = 1;`,
            );
          grantedByUserId = lookup.recordset[0]?.user_id ?? null;
        } catch {
          // non-fatal
        }
      }

      const personas = await setPersonasForMember(req.params.id, normalized, grantedByUserId);
      res.json({ personas });
    } catch (error) {
      next(error);
    }
  },
);

router.get('/:id', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const member = await getMemberById(req.params.id);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    res.json(member);
  } catch (error) {
    next(error);
  }
});
router.get('/:id/groups', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const groups = await getMemberGroups(req.params.id);
    res.json(groups);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/sms-consent', writeLimiter, authenticate, async (req, res, next) => {
  try {
    const memberId = req.params.id;
    const smsOptIn = req.body?.sms_opt_in;
    if (typeof smsOptIn !== 'boolean') {
      res.status(400).json({ error: 'sms_opt_in boolean is required.' });
      return;
    }

    const pool = await getPool();
    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ member_id: string; email: string | null }>(
        `SELECT member_id, email
         FROM member
         WHERE member_id = @member_id`
      );

    const memberRecord = memberResult.recordset[0];
    if (!memberRecord) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    if (!isAdmin(req) && !isSelfMember(req, memberId, memberRecord.email)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }

    if (smsOptIn) {
      const rolloutStatus = await getSmsRolloutStatus(memberId, memberRecord.email);
      if (!rolloutStatus.enabled) {
        res.status(403).json({
          error: 'SMS enrollment is not enabled for this account yet.',
          reason: rolloutStatus.reason,
        });
        return;
      }
    }

    const updatedResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .input('sms_opt_in', sql.Bit, smsOptIn ? 1 : 0)
      .query(
        `UPDATE member
         SET sms_opt_in = @sms_opt_in,
             sms_opt_in_date = CASE WHEN @sms_opt_in = 1 THEN GETUTCDATE() ELSE sms_opt_in_date END,
             sms_opt_out_date = CASE WHEN @sms_opt_in = 1 THEN NULL ELSE GETUTCDATE() END,
             updated_at = GETUTCDATE()
         OUTPUT INSERTED.*
         WHERE member_id = @member_id`
      );

    const updated = updatedResult.recordset[0];
    if (!updated) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    await notificationService.writeSmsConsentLog(
      memberId,
      smsOptIn ? 'opt_in' : 'opt_out',
      'manual'
    );

    if (smsOptIn && updated.mobile_phone) {
      await notificationService.sendSms({
        to: updated.mobile_phone,
        message: "PHW Alpine: You've opted in for event notifications. Reply STOP to unsubscribe. Msg&data rates may apply.",
        memberId,
      });
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/channel-preference', writeLimiter, authenticate, async (req, res, next) => {
  try {
    const memberId = req.params.id;
    const preference = req.body?.channel_preference as string | undefined;

    if (preference !== 'email_only' && preference !== 'sms_only' && preference !== 'both') {
      res.status(400).json({ error: 'channel_preference must be one of: email_only, sms_only, both.' });
      return;
    }

    const nextSmsOptIn = preference === 'sms_only' || preference === 'both';
    const nextEmailOptOut = preference === 'sms_only';
    const pool = await getPool();

    const existingResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{
        member_id: string;
        email: string | null;
        mobile_phone: string | null;
        sms_opt_in: boolean;
      }>(
        `SELECT member_id, email, mobile_phone, sms_opt_in
         FROM member
         WHERE member_id = @member_id`
      );

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    if (!isAdmin(req) && !isSelfMember(req, memberId, existing.email)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }

    if (nextSmsOptIn) {
      const rolloutStatus = await getSmsRolloutStatus(memberId, existing.email);
      if (!rolloutStatus.enabled) {
        res.status(403).json({
          error: 'SMS enrollment is not enabled for this account yet.',
          reason: rolloutStatus.reason,
        });
        return;
      }
    }

    if (nextSmsOptIn && !existing.mobile_phone) {
      res.status(400).json({ error: 'A mobile phone number is required before SMS can be enabled.' });
      return;
    }

    const updatedResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .input('sms_opt_in', sql.Bit, nextSmsOptIn ? 1 : 0)
      .input('email_opt_out', sql.Bit, nextEmailOptOut ? 1 : 0)
      .query(
        `UPDATE member
         SET sms_opt_in = @sms_opt_in,
             sms_opt_in_date = CASE WHEN @sms_opt_in = 1 THEN GETUTCDATE() ELSE sms_opt_in_date END,
             sms_opt_out_date = CASE WHEN @sms_opt_in = 1 THEN NULL ELSE GETUTCDATE() END,
             email_opt_out = @email_opt_out,
             updated_at = GETUTCDATE()
         OUTPUT INSERTED.*
         WHERE member_id = @member_id`
      );

    const updated = updatedResult.recordset[0];
    if (!updated) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    if (existing.sms_opt_in !== nextSmsOptIn) {
      await notificationService.writeSmsConsentLog(
        memberId,
        nextSmsOptIn ? 'opt_in' : 'opt_out',
        'manual',
        'Updated from channel preference'
      );
    }

    if (nextSmsOptIn && updated.mobile_phone) {
      await notificationService.sendSms({
        to: updated.mobile_phone,
        message: "PHW Alpine: You've opted in for event notifications. Reply STOP to unsubscribe. Msg&data rates may apply.",
        memberId,
      });
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/sms-consent-log', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const memberId = req.params.id;
    const pool = await getPool();
    if (!isAdmin(req)) {
      const memberResult = await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ member_id: string; email: string | null }>(
          `SELECT member_id, email
           FROM member
           WHERE member_id = @member_id`
        );

      const memberRecord = memberResult.recordset[0];
      if (!memberRecord) {
        res.status(404).json({ error: 'Member not found.' });
        return;
      }

      if (!isSelfMember(req, memberId, memberRecord.email)) {
        res.status(403).json({ error: 'Insufficient permissions.' });
        return;
      }
    }

    const result = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query(
        `SELECT consent_log_id, member_id, action, source, recorded_at, notes
         FROM sms_consent_log
         WHERE member_id = @member_id
         ORDER BY recorded_at DESC`
      );
    res.json(result.recordset);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/sms-rollout-status', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const memberId = req.params.id;
    const pool = await getPool();
    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ member_id: string; email: string | null }>(
        `SELECT member_id, email
         FROM member
         WHERE member_id = @member_id`
      );

    const memberRecord = memberResult.recordset[0];
    if (!memberRecord) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    if (!isAdmin(req) && !isSelfMember(req, memberId, memberRecord.email)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }

    const rolloutStatus = await getSmsRolloutStatus(memberId, memberRecord.email);
    res.json({
      member_id: memberId,
      sms_rollout_enabled: rolloutStatus.enabled,
      reason: rolloutStatus.reason,
      configured_emails: rolloutStatus.configuredEmails,
      configured_groups: rolloutStatus.configuredGroups,
      matched_groups: rolloutStatus.matchedGroups,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/participation', apiLimiter, authenticate, async (req, res, next) => {
  try {
    const memberId = req.params.id;
    const pool = await getPool();
    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ member_id: string; email: string | null }>(
        `SELECT member_id, email
         FROM member
         WHERE member_id = @member_id`
      );

    const memberRecord = memberResult.recordset[0];
    if (!memberRecord) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    if (!isAdmin(req) && !isSelfMember(req, memberId, memberRecord.email)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }

    const currentYear = new Date().getFullYear();
    const priorYear = currentYear - 1;
    const result = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .input('current_year', sql.Int, currentYear)
      .input('prior_year', sql.Int, priorYear)
      .query<{
        events_attended: number;
        events_attended_prior_year: number;
        mentor_attended: number;
        mentor_attended_prior_year: number;
        participant_attended: number;
        participant_attended_prior_year: number;
      }>(
        `SELECT
            SUM(CASE WHEN YEAR(e.event_date) = @current_year AND ea.attended = 1 THEN 1 ELSE 0 END) AS events_attended,
            SUM(CASE WHEN YEAR(e.event_date) = @prior_year AND ea.attended = 1 THEN 1 ELSE 0 END) AS events_attended_prior_year,
            SUM(CASE WHEN YEAR(e.event_date) = @current_year AND ea.attended = 1 AND ea.role = 'MENTOR' THEN 1 ELSE 0 END) AS mentor_attended,
            SUM(CASE WHEN YEAR(e.event_date) = @prior_year AND ea.attended = 1 AND ea.role = 'MENTOR' THEN 1 ELSE 0 END) AS mentor_attended_prior_year,
            SUM(CASE WHEN YEAR(e.event_date) = @current_year AND ea.attended = 1 AND ea.role = 'PARTICIPANT' THEN 1 ELSE 0 END) AS participant_attended,
            SUM(CASE WHEN YEAR(e.event_date) = @prior_year AND ea.attended = 1 AND ea.role = 'PARTICIPANT' THEN 1 ELSE 0 END) AS participant_attended_prior_year
         FROM event_assignment ea
         INNER JOIN event e ON e.event_id = ea.event_id
         WHERE ea.member_id = @member_id
           AND e.status = 'completed'`
      );

    res.json({
      member_id: memberId,
      year: currentYear,
      events_attended: result.recordset[0]?.events_attended ?? 0,
      events_attended_prior_year: result.recordset[0]?.events_attended_prior_year ?? 0,
      mentor_attended: result.recordset[0]?.mentor_attended ?? 0,
      mentor_attended_prior_year: result.recordset[0]?.mentor_attended_prior_year ?? 0,
      participant_attended: result.recordset[0]?.participant_attended ?? 0,
      participant_attended_prior_year: result.recordset[0]?.participant_attended_prior_year ?? 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/me/rsvps', apiLimiter, authenticate, async (req, res, next) => {
  try {
    const memberId = await resolveSelfMemberId(req.user?.sub, req.user?.email, req.user?.rawClaims);
    if (!memberId) {
      res.json([]);
      return;
    }

    const limit = parsePositiveIntQuery(req.query.limit, 50);
    const rows = await withShortLivedCache(
      `members:my-rsvps:${memberId}:limit=${limit ?? 'all'}`,
      DASHBOARD_CACHE_TTL_MS,
      async () => {
        const topClause = limit !== null ? 'TOP (@limit) ' : '';
        const pool = await getPool();
        const primaryRequest = pool
          .request()
          .input('member_id', sql.UniqueIdentifier, memberId);
        if (limit !== null) {
          primaryRequest.input('limit', sql.Int, limit);
        }
        const result = await primaryRequest
          .query(
            `SELECT ${topClause}
                er.response_id,
                er.response,
                er.responded_at,
                e.event_id,
                e.title,
                e.event_date,
                e.location,
                e.status
             FROM event_response er
             INNER JOIN event e ON e.event_id = er.event_id
             WHERE er.member_id = @member_id
             ORDER BY e.event_date ASC`
          );

        if ((result.recordset.length === 0) && req.user?.email?.trim()) {
          const normalizedEmail = req.user.email.trim().toLowerCase();
          const fallbackMember = await pool
            .request()
            .input('email', sql.NVarChar(320), normalizedEmail)
            .query<{ member_id: string }>(
              `SELECT TOP 1 m.member_id
               FROM member m
               CROSS APPLY (
                 SELECT MAX(er.responded_at) AS last_responded_at
                 FROM event_response er
                 WHERE er.member_id = m.member_id
               ) r
               WHERE LOWER(m.email) = @email
                 AND r.last_responded_at IS NOT NULL
               ORDER BY m.is_active DESC, r.last_responded_at DESC, m.updated_at DESC`
            );

          const fallbackMemberId = fallbackMember.recordset[0]?.member_id;
          if (fallbackMemberId && fallbackMemberId !== memberId) {
            const fallbackRequest = pool
              .request()
              .input('member_id', sql.UniqueIdentifier, fallbackMemberId);
            if (limit !== null) {
              fallbackRequest.input('limit', sql.Int, limit);
            }
            const fallbackResponses = await fallbackRequest
              .query(
                `SELECT ${topClause}
                    er.response_id,
                    er.response,
                    er.responded_at,
                    e.event_id,
                    e.title,
                    e.event_date,
                    e.location,
                    e.status
                 FROM event_response er
                 INNER JOIN event e ON e.event_id = er.event_id
                 WHERE er.member_id = @member_id
                 ORDER BY e.event_date ASC`
              );

            return fallbackResponses.recordset;
          }
        }

        return result.recordset;
      }
    );

    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/rsvps', apiLimiter, authenticate, async (req, res, next) => {
  try {
    const memberId = req.params.id;
    const pool = await getPool();
    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ member_id: string; email: string | null }>(
        `SELECT member_id, email
         FROM member
         WHERE member_id = @member_id`
      );

    const memberRecord = memberResult.recordset[0];
    if (!memberRecord) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    if (!isAdmin(req) && !isSelfMember(req, memberId, memberRecord.email)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }

    const result = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query(
        `SELECT
            er.response_id,
            er.response,
            er.responded_at,
            e.event_id,
            e.title,
            e.event_date,
            e.location,
            e.status
         FROM event_response er
         INNER JOIN event e ON e.event_id = er.event_id
         WHERE er.member_id = @member_id
         ORDER BY e.event_date ASC`
      );

    res.json(result.recordset);
  } catch (error) {
    next(error);
  }
});

router.post('/', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    if (!req.body?.first_name || !req.body?.last_name || !req.body?.email) {
      res.status(400).json({ error: 'first_name, last_name, and email are required.' });
      return;
    }

    const member = await createMember(req.body);
    res.status(201).json(member);
  } catch (error: unknown) {
    if (isHttpError(error, 409)) {
      res.status(409).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.patch('/:id', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const member = await updateMember(req.params.id, req.body);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    res.json(member);
  } catch (error: unknown) {
    if (isHttpError(error, 409)) {
      res.status(409).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.delete('/:id', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const member = await deactivateMember(req.params.id);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    res.json({ message: 'Member deactivated.', member });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/purge', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const member = await hardDeleteMember(req.params.id);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    res.json({ message: 'Member permanently deleted.', member });
  } catch (error) {
    next(error);
  }
});

function isHttpError(error: unknown, statusCode: number): error is Error & { statusCode?: number } {
  return error instanceof Error && (error as Error & { statusCode?: number }).statusCode === statusCode;
}

function isAdmin(req: { user?: { roles?: string[] } }): boolean {
  return Boolean(req.user?.roles?.includes('ADMIN'));
}

function isSelfMember(req: { user?: { sub?: string; email?: string } }, memberId: string, memberEmail: string | null): boolean {
  if (req.user?.sub === memberId) {
    return true;
  }

  if (!req.user?.email || !memberEmail) {
    return false;
  }

  return req.user.email.trim().toLowerCase() === memberEmail.trim().toLowerCase();
}

function parseLowercaseCsv(input: string | undefined): string[] {
  if (!input) {
    return [];
  }

  const parts = input
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(parts)];
}

function getConfiguredSmsRolloutAllowlist(): { emails: string[]; groups: string[] } {
  const emailsFromEnv = parseLowercaseCsv(process.env['SMS_CONSENT_ROLLOUT_EMAIL_ALLOWLIST']);
  const groupsFromEnv = parseLowercaseCsv(process.env['SMS_CONSENT_ROLLOUT_GROUP_ALLOWLIST']);

  return { emails: emailsFromEnv, groups: groupsFromEnv };
}

async function getSmsRolloutStatus(memberId: string, memberEmail: string | null): Promise<SmsRolloutStatus> {
  const configured = getConfiguredSmsRolloutAllowlist();

  if (configured.emails.length === 0 && configured.groups.length === 0) {
    return {
      enabled: true,
      reason: 'open_rollout',
      configuredEmails: configured.emails,
      configuredGroups: configured.groups,
      matchedGroups: [],
    };
  }

  if (!memberEmail) {
    return {
      enabled: false,
      reason: 'missing_member_email',
      configuredEmails: configured.emails,
      configuredGroups: configured.groups,
      matchedGroups: [],
    };
  }

  const normalizedEmail = memberEmail.trim().toLowerCase();
  if (configured.emails.includes(normalizedEmail)) {
    return {
      enabled: true,
      reason: 'email_allowlist',
      configuredEmails: configured.emails,
      configuredGroups: configured.groups,
      matchedGroups: [],
    };
  }

  if (configured.groups.length > 0) {
    const memberGroups = await getMemberGroups(memberId);
    const matchedGroups = memberGroups
      .map((group) => group.group_name.trim().toLowerCase())
      .filter((groupName) => configured.groups.includes(groupName));

    if (matchedGroups.length > 0) {
      return {
        enabled: true,
        reason: 'group_allowlist',
        configuredEmails: configured.emails,
        configuredGroups: configured.groups,
        matchedGroups,
      };
    }
  }

  return {
    enabled: false,
    reason: 'not_in_rollout_cohort',
    configuredEmails: configured.emails,
    configuredGroups: configured.groups,
    matchedGroups: [],
  };
}

async function resolveSelfMemberId(
  subject: string | undefined,
  email: string | undefined,
  rawClaims?: Record<string, unknown>
): Promise<string | null> {
  const pool = await getPool();

  const entraObjectId = typeof rawClaims?.['oid'] === 'string' ? rawClaims['oid'].trim() : undefined;
  const issuer = typeof rawClaims?.['iss'] === 'string' ? rawClaims['iss'].trim() : undefined;
  const issuerAssignedId = typeof subject === 'string' ? subject.trim() : undefined;

  if (entraObjectId || (issuer && issuerAssignedId)) {
    const byIdentityLink = await pool
      .request()
      .input('entra_object_id', sql.NVarChar(255), entraObjectId ?? null)
      .input('issuer', sql.NVarChar(255), issuer ?? null)
      .input('issuer_assigned_id', sql.NVarChar(255), issuerAssignedId ?? null)
      .query<{ member_id: string }>(
        `SELECT TOP 1 mil.member_id
         FROM member_identity_link mil
         INNER JOIN member m ON m.member_id = mil.member_id
         WHERE (
            (@entra_object_id IS NOT NULL AND mil.entra_object_id = @entra_object_id)
            OR (@issuer IS NOT NULL AND @issuer_assigned_id IS NOT NULL AND mil.issuer = @issuer AND mil.issuer_assigned_id = @issuer_assigned_id)
         )
         ORDER BY m.is_active DESC, m.updated_at DESC`
      );

    const linkedMemberId = byIdentityLink.recordset[0]?.member_id;
    if (linkedMemberId) {
      return linkedMemberId;
    }
  }

  if (email?.trim()) {
    const normalizedEmail = email.trim().toLowerCase();
    const byEmail = await pool
      .request()
      .input('email', sql.NVarChar(320), normalizedEmail)
      .query<{ member_id: string }>(
        `SELECT TOP 1 member_id
         FROM member
         WHERE LOWER(email) = @email
         ORDER BY is_active DESC, updated_at DESC`
      );

    const memberId = byEmail.recordset[0]?.member_id;
    if (memberId) {
      return memberId;
    }
  }

  if (subject && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject)) {
    const byId = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, subject)
      .query<{ member_id: string }>(
        `SELECT member_id
         FROM member
         WHERE member_id = @member_id`
      );

    return byId.recordset[0]?.member_id ?? null;
  }

  return null;
}

export default router;