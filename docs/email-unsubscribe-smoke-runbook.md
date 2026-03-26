# Email Unsubscribe Smoke Runbook

Date: 2026-03-26
Owner: Engineering
Related launch work items: LR-05

## Purpose

Run a repeatable smoke check for email unsubscribe compliance behavior after backend deployment.

This runbook covers:
- Invalid-token contract behavior
- Optional live unsubscribe token execution
- Optional admin audit-log verification

## Script

Script location:
- `scripts/email-unsubscribe-smoke.js`

NPM shortcut:
- `npm --prefix backend run smoke:email`

## Environment Variables

Required:
- `BACKEND_BASE_URL` example: `https://phwalpineeventsjb873a.azurewebsites.net`

Optional:
- `EMAIL_TEST_ENABLE_LIVE` set `1` to run live unsubscribe flow
- `EMAIL_UNSUBSCRIBE_TOKEN` signed token required when live mode enabled
- `EMAIL_ADMIN_BEARER_TOKEN` optional admin JWT to verify `GET /api/v1/preferences/email/logs`
- `EMAIL_EXPECTED_LOG_OUTCOMES` comma-separated outcomes expected in admin log check (default: `invalid_token,unsubscribed,already_unsubscribed`)

## Safe Contract-Only Run

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
npm --prefix backend run smoke:email
```

Expected output includes:
- `result=PASS`
- `unsubscribe_invalid_status=400`
- `unsubscribe_invalid_contains=yes`

If `EMAIL_ADMIN_BEARER_TOKEN` is set, also expect:
- `admin_email_logs_status=200`
- `admin_email_logs_expected_outcome=yes`

## Live Run (Destructive)

Use only with a dedicated test member token. This action may set `email_opt_out=1`.

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
EMAIL_TEST_ENABLE_LIVE=1 \
EMAIL_UNSUBSCRIBE_TOKEN="<signed-token>" \
npm --prefix backend run smoke:email
```

Expected output includes:
- `live_unsubscribe_status=200`
- `live_unsubscribe_contains=yes`
- `live_admin_email_logs_outcome_match=yes` (when `EMAIL_ADMIN_BEARER_TOKEN` is set)
- `result=PASS`

Post-step:
- Re-enable test member email notifications as needed in admin member management.

## CI/CD Integration Recommendation

Run contract-only mode in deployment pipeline after backend deploy:
1. Set `BACKEND_BASE_URL` for environment
2. Execute smoke script
3. Fail pipeline if script exits non-zero
4. Store output as build artifact for audit trail

## Troubleshooting

1. `result=FAIL` with invalid-token mismatch:
- Verify route path is `/api/v1/preferences/email/unsubscribe/:token`
- Confirm backend deployment is current

2. `admin_email_logs_status` not 200:
- Validate admin JWT scope/claims and API auth config

3. Live mode fails:
- Confirm token is current and signed by deployed secret
- Confirm the member record exists in deployed database
