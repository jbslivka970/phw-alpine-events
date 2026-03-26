import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { verifyEmailUnsubscribeToken } from '../services/emailPreferenceLinkService';
import { notificationService } from '../services/notifications';

const router = Router();

type UnsubscribeOutcome = 'unsubscribed' | 'already_unsubscribed' | 'member_not_found' | 'invalid_token';

interface UnsubscribeResult {
  statusCode: number;
  outcome: UnsubscribeOutcome;
  memberId?: string;
  email?: string;
}

function renderUnsubscribeHtml(result: UnsubscribeResult): string {
  const title = result.outcome === 'unsubscribed' || result.outcome === 'already_unsubscribed'
    ? 'Email Preferences Updated'
    : 'Unsubscribe Link Invalid';

  const message = (() => {
    if (result.outcome === 'unsubscribed') {
      return 'You have been unsubscribed from PHW Alpine email notifications.';
    }
    if (result.outcome === 'already_unsubscribed') {
      return 'This address is already unsubscribed from PHW Alpine email notifications.';
    }
    if (result.outcome === 'member_not_found') {
      return 'We could not match this unsubscribe request to a member profile.';
    }
    return 'This unsubscribe link is invalid or expired.';
  })();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: Segoe UI, Arial, sans-serif; background: #f8fafc; color: #111827; margin: 0; padding: 24px; }
      .card { max-width: 560px; margin: 40px auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 24px; }
      h1 { font-size: 22px; margin: 0 0 12px 0; }
      p { margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

async function processUnsubscribeToken(tokenString: string): Promise<UnsubscribeResult> {
  let token;
  try {
    token = verifyEmailUnsubscribeToken(tokenString);
  } catch (error) {
    await notificationService.writeEmailPreferenceLog({
      action: 'opt_out',
      source: 'link',
      outcome: 'invalid_token',
      notes: error instanceof Error ? error.message : String(error),
    });
    return {
      statusCode: 400,
      outcome: 'invalid_token',
    };
  }

  const pool = await getPool();
  const memberResult = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, token.memberId)
    .query<{ member_id: string; email: string; email_opt_out: boolean }>(
      `SELECT member_id, email, ISNULL(email_opt_out, 0) AS email_opt_out
       FROM member
       WHERE member_id = @member_id`
    );

  const member = memberResult.recordset[0];
  if (!member) {
    await notificationService.writeEmailPreferenceLog({
      action: 'opt_out',
      source: 'link',
      outcome: 'member_not_found',
      notes: `Token member_id ${token.memberId} was not found.`,
      tokenExpiresAt: token.expiresAt,
    });

    return {
      statusCode: 404,
      outcome: 'member_not_found',
    };
  }

  if (member.email_opt_out) {
    await notificationService.writeEmailPreferenceLog({
      memberId: member.member_id,
      recipientEmail: member.email,
      action: 'opt_out',
      source: 'link',
      outcome: 'already_unsubscribed',
      tokenExpiresAt: token.expiresAt,
      notes: 'Unsubscribe link clicked after opt-out was already set.',
    });

    return {
      statusCode: 200,
      outcome: 'already_unsubscribed',
      memberId: member.member_id,
      email: member.email,
    };
  }

  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, member.member_id)
    .query(
      `UPDATE member
       SET email_opt_out = 1,
           updated_at = GETUTCDATE(),
           last_manual_edit = GETUTCDATE()
       WHERE member_id = @member_id`
    );

  await notificationService.writeEmailPreferenceLog({
    memberId: member.member_id,
    recipientEmail: member.email,
    action: 'opt_out',
    source: 'link',
    outcome: 'unsubscribed',
    tokenExpiresAt: token.expiresAt,
    notes: 'Email opt-out set via signed unsubscribe link.',
  });

  return {
    statusCode: 200,
    outcome: 'unsubscribed',
    memberId: member.member_id,
    email: member.email,
  };
}

router.get('/email/unsubscribe/:token', apiLimiter, async (req, res) => {
  try {
    const result = await processUnsubscribeToken(req.params.token);
    res.status(result.statusCode).set('Content-Type', 'text/html; charset=utf-8').send(renderUnsubscribeHtml(result));
  } catch (error) {
    console.error('GET /preferences/email/unsubscribe/:token failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/email/unsubscribe/:token', writeLimiter, async (req, res) => {
  try {
    const result = await processUnsubscribeToken(req.params.token);
    res.status(result.statusCode).json({
      status: result.outcome,
      member_id: result.memberId ?? null,
      email: result.email ?? null,
    });
  } catch (error) {
    console.error('POST /preferences/email/unsubscribe/:token failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/email/logs', apiLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

    const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;

    const pool = await getPool();
    const result = await pool
      .request()
      .input('limit', sql.Int, limit)
      .input('outcome', sql.NVarChar, outcome ?? null)
      .input('source', sql.NVarChar, source ?? null)
      .query(
        `SELECT TOP (@limit)
            email_preference_log_id,
            member_id,
            recipient_email,
            action,
            source,
            outcome,
            token_expires_at,
            notes,
            recorded_at
         FROM email_preference_log
         WHERE (@outcome IS NULL OR outcome = @outcome)
           AND (@source IS NULL OR source = @source)
         ORDER BY recorded_at DESC`
      );

    res.json({
      count: result.recordset.length,
      rows: result.recordset,
    });
  } catch (error) {
    console.error('GET /preferences/email/logs failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;