# Reminder Duplication Smoke Runbook

Date: 2026-03-26
Owner: Engineering
Related launch work items: LR-03

## Purpose

Run a repeatable admin-only check for reminder duplicate evidence.

This runbook covers:
- Access to the reminder duplicate report endpoint
- Optional enforcement that duplicate reminder count is zero

## Script

Script location:
- `scripts/reminder-duplication-smoke.js`

NPM shortcut:
- `npm --prefix backend run smoke:reminders`

## Environment Variables

Required:
- `BACKEND_BASE_URL` example: `https://phwalpineeventsjb873a.azurewebsites.net`
- `REMINDER_ADMIN_BEARER_TOKEN` admin JWT for report access

Optional:
- `REMINDER_REPORT_DAYS` lookback days (default `30`)
- `REMINDER_EXPECT_NO_DUPLICATES` set `1` to fail when duplicates exist

## Report-Only Run

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
REMINDER_ADMIN_BEARER_TOKEN="<admin-jwt>" \
npm --prefix backend run smoke:reminders
```

Expected output includes:
- `reminder_report_status=200`
- `result=PASS`

## Enforced No-Duplicate Run

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
REMINDER_ADMIN_BEARER_TOKEN="<admin-jwt>" \
REMINDER_EXPECT_NO_DUPLICATES=1 \
npm --prefix backend run smoke:reminders
```

Expected output includes:
- `reminder_duplicate_count=0`
- `result=PASS`

## Troubleshooting

1. Report returns 401/403:
- Verify token is valid admin JWT with API audience

2. duplicate_count > 0:
- Inspect response rows for event/member/channel combinations
- Correlate with scheduler logs and deployment timings
- Investigate whether multiple scheduler instances ran simultaneously
