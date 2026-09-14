# Webhook security rollout

## Required configuration

- Set `TELNYX_WEBHOOK_PUBLIC_KEY` to the Telnyx Ed25519 webhook public key.
- Set `MAILGUN_WEBHOOK_SIGNING_KEY` to the Mailgun HTTP webhook signing key.
- Configure each active tenant's `dbo.tenant_messaging.telnyx_from_number` or `sms_from` with a unique destination number.
- Do not use `SUPPORT_INBOUND_WEBHOOK_TOKEN` as production authentication. It remains available only for nonproduction compatibility.

## Rollout order

1. Apply `database/schema.sql` before deploying the backend. The script adds `dbo.webhook_receipt`, SMS audit tenant/provider columns, and consent tenant attribution idempotently.
2. Verify that no normalized Telnyx destination is assigned to more than one active, SMS-enabled tenant.
3. Add both signing keys to the backend secret store and deployment slot settings.
4. Deploy to staging and send one signed webhook from each provider. Confirm a receipt row and the expected tenant-scoped SMS or support relay result.
5. Replay each signed request and confirm an idempotent success without a second RSVP, consent mutation, SMS reply, or support email.
6. Swap or deploy production only after forged and stale requests return `401` and missing or ambiguous SMS destinations fail closed.

Unsigned Event Grid subscription validation remains supported. Event Grid notification and direct payload forms are rejected in production. Tokenized RSVP requests retain their existing signed-token flow and do not use provider receipt claims.

## Retention and rollback

Webhook receipts expire seven days after claim. The retention job removes expired rows after `RETENTION_WEBHOOK_RECEIPT_DAYS` (default one additional day), subject to the existing dry-run, confirmation, batching, and deletion-cap controls.

For rollback, keep the additive table and nullable audit columns in place, restore the previous backend version, and retain both provider signing secrets. Do not drop receipts during rollback because they preserve replay protection across deployments.