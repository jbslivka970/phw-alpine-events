import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin, requireAnyAuthenticatedRole } from '../middleware/rbac';
import { getMemberGroups } from '../services/groupService';
import {
  createMember,
  deactivateMember,
  getMemberById,
  listMembers,
  updateMember,
} from '../services/memberService';
import { notificationService } from '../services/notifications';
import { loadAcsConfig } from '../config';

const router = Router();

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

// GET /members/:id/rsvps — events the member has responded to
router.get('/:id/rsvps', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const requestingUser = (req as { user?: { sub: string; roles: string[] } }).user;
    const targetId = req.params.id;

    // Only the member themselves or an admin can view RSVPs
    if (requestingUser && !requestingUser.roles.includes('ADMIN') && requestingUser.sub !== targetId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, targetId)
      .query(
        `SELECT er.response_id, er.response, er.responded_at,
                e.event_id, e.title, e.event_date, e.location, e.status
         FROM event_response er
         INNER JOIN event e ON e.event_id = er.event_id
         WHERE er.member_id = @member_id
         ORDER BY e.event_date DESC`
      );
    res.json(result.recordset);
  } catch (error) {
    next(error);
  }
});

// GET /members/:id/participation — attendance summary for a member
router.get('/:id/participation', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const priorYear = year - 1;
    const pool = await getPool();
    const result = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, req.params.id)
      .input('yearStart', sql.DateTime, new Date(year, 0, 1))
      .input('yearEnd', sql.DateTime, new Date(year, 11, 31, 23, 59, 59))
      .input('priorYearStart', sql.DateTime, new Date(priorYear, 0, 1))
      .input('priorYearEnd', sql.DateTime, new Date(priorYear, 11, 31, 23, 59, 59))
      .query<{ events_attended: number; events_attended_prior_year: number }>(
        `SELECT
           (SELECT COUNT(*)
            FROM event_assignment ea
            INNER JOIN event e ON e.event_id = ea.event_id
            WHERE ea.member_id = @member_id AND ea.attended = 1
              AND e.event_date BETWEEN @yearStart AND @yearEnd) AS events_attended,
           (SELECT COUNT(*)
            FROM event_assignment ea
            INNER JOIN event e ON e.event_id = ea.event_id
            WHERE ea.member_id = @member_id AND ea.attended = 1
              AND e.event_date BETWEEN @priorYearStart AND @priorYearEnd) AS events_attended_prior_year`
      );
    res.json({ member_id: req.params.id, year, ...result.recordset[0] });
  } catch (error) {
    next(error);
  }
});

// PATCH /members/:id/sms-consent
router.patch('/:id/sms-consent', writeLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res, next) => {
  try {
    const requestingUser = (req as { user?: { sub: string; roles: string[] } }).user;
    const targetId = req.params.id;

    // Only the member themselves or an admin can update consent
    if (requestingUser && !requestingUser.roles.includes('ADMIN') && requestingUser.sub !== targetId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { sms_opt_in } = req.body as { sms_opt_in?: boolean };
    if (typeof sms_opt_in !== 'boolean') {
      res.status(400).json({ error: 'sms_opt_in (boolean) is required' });
      return;
    }

    const pool = await getPool();

    // Get member's current phone number
    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, targetId)
      .query<{ mobile_phone: string | null; first_name: string }>('SELECT mobile_phone, first_name FROM member WHERE member_id = @member_id');

    const member = memberResult.recordset[0];
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    if (sms_opt_in) {
      await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, targetId)
        .query(
          `UPDATE member
           SET sms_opt_in = 1, sms_opt_in_date = GETUTCDATE(), sms_opt_out_date = NULL
           WHERE member_id = @member_id`
        );

      await notificationService.writeSmsConsentLog(targetId, 'opt_in', 'manual');

      // Send TCPA opt-in confirmation if ACS is configured and member has a phone
      const acsConfig = loadAcsConfig();
      if (acsConfig.isConfigured && acsConfig.smsFrom && member.mobile_phone) {
        await notificationService.sendSms({
          to: member.mobile_phone,
          message:
            'PHW Alpine: You\'ve opted in for event notifications. Reply STOP to unsubscribe. Msg&data rates may apply.',
          memberId: targetId,
        });
      }
    } else {
      await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, targetId)
        .query(
          `UPDATE member
           SET sms_opt_in = 0, sms_opt_out_date = GETUTCDATE()
           WHERE member_id = @member_id`
        );

      await notificationService.writeSmsConsentLog(targetId, 'opt_out', 'manual');
    }

    res.json({ member_id: targetId, sms_opt_in });
  } catch (error) {
    next(error);
  }
});

// GET /members/:id/sms-consent-log
router.get('/:id/sms-consent-log', apiLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, req.params.id)
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

function isHttpError(error: unknown, statusCode: number): error is Error & { statusCode?: number } {
  return error instanceof Error && (error as Error & { statusCode?: number }).statusCode === statusCode;
}

export default router;