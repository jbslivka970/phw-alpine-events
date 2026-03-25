# SMS Compliance Smoke Runbook

Date: 2026-03-25
Owner: Engineering
Related launch work items: LR-01, LR-02

## Purpose

Run a repeatable smoke check for inbound SMS handling and compliance-critical behavior after backend deployment.

This runbook covers:
- Event Grid subscription validation handling
- Event Grid SMS batch payload handling
- Inbound HELP and unknown command contract behavior
- Optional live member checks for HELP/RSVP
- Optional destructive STOP check (opt-out)

## Script

Script location:
- `scripts/sms-compliance-smoke.js`

NPM shortcut:
- `npm --prefix backend run smoke:sms`

## Environment Variables

Required:
- `BACKEND_BASE_URL` example: `https://phwalpineeventsjb873a.azurewebsites.net`

Optional:
- `SMS_NON_MEMBER_PHONE` default: `+15555550199`
- `SMS_TEST_ENABLE_LIVE` set `1` to run live checks
- `SMS_TEST_PHONE` required when live checks enabled
- `SMS_TEST_ENABLE_STOP` set `1` to run STOP check (destructive)
- `SMS_ADMIN_BEARER_TOKEN` optional admin JWT to verify `GET /api/v1/sms/inbound/logs`

## Safe Contract-Only Run

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
npm --prefix backend run smoke:sms
```

Expected output includes:
- `result=PASS`
- `eventgrid_validation_status=200`
- `eventgrid_batch_status=200`
- `help_unknown_status=200`

If `SMS_ADMIN_BEARER_TOKEN` is set, also expect:
- `admin_logs_status=200`

## Live Non-Destructive Run

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
SMS_TEST_ENABLE_LIVE=1 \
SMS_TEST_PHONE="+1XXXXXXXXXX" \
npm --prefix backend run smoke:sms
```

Expected output includes:
- `live_help_status=200`
- `live_rsvp_status=200`
- `result=PASS`

## Live STOP Run (Destructive)

Use only with a dedicated test member that can be re-enabled.

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
SMS_TEST_ENABLE_LIVE=1 \
SMS_TEST_ENABLE_STOP=1 \
SMS_TEST_PHONE="+1XXXXXXXXXX" \
npm --prefix backend run smoke:sms
```

Expected output includes:
- `live_stop_status=200`
- `live_stop_body={..."status":"opted_out"...}`
- `result=PASS`

Post-step:
- Re-enable test member SMS opt-in using admin preferences UI or database update.

## CI/CD Integration Recommendation

Run contract-only mode in deployment pipeline after backend deploy:
1. Set `BACKEND_BASE_URL` for environment
2. Execute smoke script
3. Fail pipeline if script exits non-zero
4. Store output as build artifact for audit trail

## Troubleshooting

1. `result=FAIL` with validation mismatch:
- Verify route path is `/api/v1/sms/inbound`
- Confirm backend deployment is current

2. `result=FAIL` in live mode with ignored responses:
- Confirm test phone matches active member `mobile_phone` in E.164

3. STOP did not opt out:
- Confirm `SMS_TEST_ENABLE_STOP=1`
- Check backend logs for route errors and DB write failures
