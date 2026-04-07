import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { notificationService } from '../services/notifications';

const router = Router();

interface RelayConfigRow {
  support_inbox_email: string;
  relay_to_csv: string;
  is_enabled: boolean;
  updated_at: Date;
  updated_by: string | null;
}

type InboundEmailStatus =
  | 'received'
  | 'relayed'
  | 'ignored_not_target'
  | 'ignored_disabled'
  | 'ignored_no_recipients'
  | 'invalid_payload'
  | 'auth_failed'
  | 'relay_failed';

function getSupportInboxAddress(): string {
  return (process.env['SUPPORT_INBOUND_EMAIL'] ?? 'support@phwcoloradoalpine.org').trim().toLowerCase();
}

function getInboundWebhookToken(): string | null {
  const raw = process.env['SUPPORT_INBOUND_WEBHOOK_TOKEN']?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function parseRecipientsCsv(csv: string | null | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);
}

function normalizeInboundAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseInboundAddresses(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const match = value.match(/<([^>]+)>/);
      return normalizeInboundAddress(match ? match[1] : value);
    });
}

function extractInboundPayload(body: unknown): {
  from: string;
  to: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  providerMessageId: string | null;
} {
  const payload = (body ?? {}) as Record<string, unknown>;

  const from = typeof payload['from'] === 'string'
    ? payload['from']
    : typeof payload['sender'] === 'string'
      ? payload['sender']
      : '';

  const toRaw = typeof payload['to'] === 'string'
    ? payload['to']
    : typeof payload['recipient'] === 'string'
      ? payload['recipient']
      : '';

  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : '(no subject)';
  const textBody = typeof payload['text'] === 'string'
    ? payload['text']
    : typeof payload['body-plain'] === 'string'
      ? payload['body-plain']
      : '';
  const htmlBody = typeof payload['html'] === 'string'
    ? payload['html']
    : typeof payload['body-html'] === 'string'
      ? payload['body-html']
      : '';

  const providerMessageId = typeof payload['message_id'] === 'string'
    ? payload['message_id']
    : typeof payload['Message-Id'] === 'string'
      ? payload['Message-Id']
      : null;

  return {
    from: from.trim(),
    to: parseInboundAddresses(toRaw),
    subject: subject.trim() || '(no subject)',
    textBody: textBody.trim(),
    htmlBody: htmlBody.trim(),
    providerMessageId,
  };
}

async function getRelayConfig(): Promise<{
  supportInboxEmail: string;
  relayRecipients: string[];
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}> {
  const supportInboxEmail = getSupportInboxAddress();
  const pool = await getPool();
  const result = await pool.request().query<RelayConfigRow>(
    `SELECT TOP (1) support_inbox_email, relay_to_csv, is_enabled, updated_at, updated_by
     FROM dbo.support_email_relay_config
     ORDER BY updated_at DESC`
  );

  const row = result.recordset[0];
  const relayRecipients = parseRecipientsCsv(row?.relay_to_csv ?? process.env['SUPPORT_RELAY_TO']);

  return {
    supportInboxEmail: normalizeInboundAddress(row?.support_inbox_email ?? supportInboxEmail),
    relayRecipients,
    enabled: row ? Boolean(row.is_enabled) : relayRecipients.length > 0,
    updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
    updatedBy: row?.updated_by ?? null,
  };
}

async function upsertRelayConfig(args: {
  supportInboxEmail: string;
  relayRecipients: string[];
  enabled: boolean;
  updatedBy: string;
}): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('support_inbox_email', sql.NVarChar(255), args.supportInboxEmail)
    .input('relay_to_csv', sql.NVarChar(sql.MAX), args.relayRecipients.join(','))
    .input('is_enabled', sql.Bit, args.enabled ? 1 : 0)
    .input('updated_by', sql.NVarChar(255), args.updatedBy)
    .query(
      `IF EXISTS (SELECT 1 FROM dbo.support_email_relay_config)
         BEGIN
           UPDATE dbo.support_email_relay_config
           SET support_inbox_email = @support_inbox_email,
               relay_to_csv = @relay_to_csv,
               is_enabled = @is_enabled,
               updated_by = @updated_by,
               updated_at = GETUTCDATE();
         END
       ELSE
         BEGIN
           INSERT INTO dbo.support_email_relay_config (
             support_relay_config_id,
             support_inbox_email,
             relay_to_csv,
             is_enabled,
             created_at,
             updated_at,
             updated_by
           )
           VALUES (
             NEWID(),
             @support_inbox_email,
             @relay_to_csv,
             @is_enabled,
             GETUTCDATE(),
             GETUTCDATE(),
             @updated_by
           );
         END`
    );
}

async function writeInboundEmailLog(entry: {
  source: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  processingStatus: InboundEmailStatus;
  relayRecipients?: string[];
  providerMessageId?: string | null;
  errorDetail?: string | null;
}): Promise<void> {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('source', sql.NVarChar(40), entry.source)
      .input('from_email', sql.NVarChar(255), entry.fromEmail)
      .input('to_email', sql.NVarChar(255), entry.toEmail)
      .input('subject', sql.NVarChar(500), entry.subject)
      .input('processing_status', sql.NVarChar(60), entry.processingStatus)
      .input('relay_recipients_csv', sql.NVarChar(sql.MAX), (entry.relayRecipients ?? []).join(','))
      .input('provider_message_id', sql.NVarChar(255), entry.providerMessageId ?? null)
      .input('error_detail', sql.NVarChar(2000), entry.errorDetail ?? null)
      .query(
        `INSERT INTO dbo.support_inbound_email_log (
           support_inbound_email_log_id,
           source,
           from_email,
           to_email,
           subject,
           processing_status,
           relay_recipients_csv,
           provider_message_id,
           error_detail,
           received_at
         )
         VALUES (
           NEWID(),
           @source,
           @from_email,
           @to_email,
           @subject,
           @processing_status,
           @relay_recipients_csv,
           @provider_message_id,
           @error_detail,
           GETUTCDATE()
         )`
      );
  } catch (error) {
    console.warn('[support] failed to write support_inbound_email_log', error);
  }
}

router.get('/relay-config', apiLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const config = await getRelayConfig();
    res.status(200).json(config);
  } catch (error) {
    console.error('GET /support/relay-config failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/relay-config', writeLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const relayTo = Array.isArray(req.body?.relay_to)
      ? req.body.relay_to.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    const relayRecipients = relayTo
      .map((value: string) => value.trim().toLowerCase())
      .filter((value: string, index: number, list: string[]) => value.length > 0 && list.indexOf(value) === index);

    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : relayRecipients.length > 0;
    const supportInboxEmailRaw = typeof req.body?.support_inbox_email === 'string'
      ? req.body.support_inbox_email
      : getSupportInboxAddress();
    const supportInboxEmail = normalizeInboundAddress(supportInboxEmailRaw);

    if (relayRecipients.length > 50) {
      res.status(400).json({ error: 'relay_to may not contain more than 50 recipients.' });
      return;
    }

    await upsertRelayConfig({
      supportInboxEmail,
      relayRecipients,
      enabled,
      updatedBy: req.user?.email ?? req.user?.sub ?? 'unknown',
    });

    const config = await getRelayConfig();
    res.status(200).json(config);
  } catch (error) {
    console.error('PUT /support/relay-config failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/inbound', writeLimiter, async (req, res) => {
  const inboundToken = getInboundWebhookToken();
  const providedToken = typeof req.headers['x-support-inbound-token'] === 'string'
    ? req.headers['x-support-inbound-token'].trim()
    : '';

  if (inboundToken && providedToken !== inboundToken) {
    await writeInboundEmailLog({
      source: 'webhook',
      fromEmail: '',
      toEmail: '',
      subject: '',
      processingStatus: 'auth_failed',
      errorDetail: 'invalid x-support-inbound-token',
    });
    res.status(401).json({ error: 'Unauthorized inbound email webhook token.' });
    return;
  }

  try {
    const payload = extractInboundPayload(req.body);
    if (!payload.from || payload.to.length === 0) {
      await writeInboundEmailLog({
        source: 'webhook',
        fromEmail: payload.from,
        toEmail: payload.to.join(','),
        subject: payload.subject,
        processingStatus: 'invalid_payload',
        providerMessageId: payload.providerMessageId,
        errorDetail: 'from and to are required',
      });
      res.status(400).json({ error: 'Inbound payload must include from and to addresses.' });
      return;
    }

    const relayConfig = await getRelayConfig();
    const supportInbox = normalizeInboundAddress(relayConfig.supportInboxEmail);
    const targetHit = payload.to.some((address) => address === supportInbox);

    if (!targetHit) {
      await writeInboundEmailLog({
        source: 'webhook',
        fromEmail: payload.from,
        toEmail: payload.to.join(','),
        subject: payload.subject,
        processingStatus: 'ignored_not_target',
        providerMessageId: payload.providerMessageId,
      });
      res.status(202).json({ status: 'ignored_not_target', support_inbox_email: supportInbox });
      return;
    }

    if (!relayConfig.enabled) {
      await writeInboundEmailLog({
        source: 'webhook',
        fromEmail: payload.from,
        toEmail: payload.to.join(','),
        subject: payload.subject,
        processingStatus: 'ignored_disabled',
        providerMessageId: payload.providerMessageId,
      });
      res.status(202).json({ status: 'ignored_disabled' });
      return;
    }

    if (relayConfig.relayRecipients.length === 0) {
      await writeInboundEmailLog({
        source: 'webhook',
        fromEmail: payload.from,
        toEmail: payload.to.join(','),
        subject: payload.subject,
        processingStatus: 'ignored_no_recipients',
        providerMessageId: payload.providerMessageId,
      });
      res.status(202).json({ status: 'ignored_no_recipients' });
      return;
    }

    const plainBody = payload.textBody || '(no plain text body provided)';
    const forwardedSubject = `[PHW Support] ${payload.subject}`;
    const forwardedTextBody = [
      `Inbound support email received.`,
      ``,
      `From: ${payload.from}`,
      `To: ${payload.to.join(', ')}`,
      `Subject: ${payload.subject}`,
      payload.providerMessageId ? `Provider Message ID: ${payload.providerMessageId}` : '',
      ``,
      `Message:`,
      plainBody,
    ].filter((line) => line.length > 0).join('\n');

    const forwardedHtmlBody = payload.htmlBody && payload.htmlBody.length > 0
      ? `<p><strong>Inbound support email received.</strong></p><p><strong>From:</strong> ${payload.from}<br/><strong>To:</strong> ${payload.to.join(', ')}<br/><strong>Subject:</strong> ${payload.subject}${payload.providerMessageId ? `<br/><strong>Provider Message ID:</strong> ${payload.providerMessageId}` : ''}</p><hr/>${payload.htmlBody}`
      : `<p><strong>Inbound support email received.</strong></p><p><strong>From:</strong> ${payload.from}<br/><strong>To:</strong> ${payload.to.join(', ')}<br/><strong>Subject:</strong> ${payload.subject}${payload.providerMessageId ? `<br/><strong>Provider Message ID:</strong> ${payload.providerMessageId}` : ''}</p><hr/><pre>${plainBody.replace(/</g, '&lt;')}</pre>`;

    const relayErrors: string[] = [];
    for (const recipient of relayConfig.relayRecipients) {
      try {
        await notificationService.sendEmail({
          to: recipient,
          subject: forwardedSubject,
          htmlBody: forwardedHtmlBody,
          textBody: forwardedTextBody,
          operationType: 'support_inbound_relay',
          operationReason: payload.from,
        });
      } catch (error) {
        relayErrors.push(`${recipient}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (relayErrors.length > 0) {
      await writeInboundEmailLog({
        source: 'webhook',
        fromEmail: payload.from,
        toEmail: payload.to.join(','),
        subject: payload.subject,
        processingStatus: 'relay_failed',
        relayRecipients: relayConfig.relayRecipients,
        providerMessageId: payload.providerMessageId,
        errorDetail: relayErrors.join(' | ').slice(0, 2000),
      });
      res.status(502).json({ status: 'relay_failed', errors: relayErrors });
      return;
    }

    await writeInboundEmailLog({
      source: 'webhook',
      fromEmail: payload.from,
      toEmail: payload.to.join(','),
      subject: payload.subject,
      processingStatus: 'relayed',
      relayRecipients: relayConfig.relayRecipients,
      providerMessageId: payload.providerMessageId,
    });

    res.status(200).json({
      status: 'relayed',
      forwarded_to: relayConfig.relayRecipients.length,
      support_inbox_email: supportInbox,
    });
  } catch (error) {
    console.error('POST /support/inbound failed', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid inbound email payload' });
  }
});

export default router;
