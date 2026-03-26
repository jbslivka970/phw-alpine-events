# Tokenized RSVP Smoke Runbook

Date: 2026-03-26
Owner: Engineering
Related launch work items: LR-04

## Purpose

Run a repeatable smoke check for tokenized RSVP behavior after backend deployment.

This runbook covers:
- Invalid-token contract behavior
- Optional live tokenized RSVP GET/POST validation

## Script

Script location:
- `scripts/tokenized-rsvp-smoke.js`

NPM shortcut:
- `npm --prefix backend run smoke:rsvp`

## Environment Variables

Required:
- `BACKEND_BASE_URL` example: `https://phwalpineeventsjb873a.azurewebsites.net`

Optional:
- `RSVP_TEST_ENABLE_LIVE` set `1` to run live checks
- `RSVP_TEST_TOKEN` signed RSVP token required when live mode enabled
- `RSVP_TEST_RESPONSE` live POST response (default `yes`)
- `RSVP_TEST_RESPONSE_ROLE` optional role for live POST (`MENTOR` or `PARTICIPANT`)

## Safe Contract-Only Run

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
npm --prefix backend run smoke:rsvp
```

Expected output includes:
- `result=PASS`
- `rsvp_invalid_get_status=401`
- `rsvp_invalid_post_status=401`

## Live Run

Use a dedicated token from a test invite. This operation will record/update RSVP state.

```bash
BACKEND_BASE_URL="https://phwalpineeventsjb873a.azurewebsites.net" \
RSVP_TEST_ENABLE_LIVE=1 \
RSVP_TEST_TOKEN="<signed-rsvp-token>" \
RSVP_TEST_RESPONSE="yes" \
RSVP_TEST_RESPONSE_ROLE="PARTICIPANT" \
npm --prefix backend run smoke:rsvp
```

Expected output includes:
- `rsvp_live_get_status=200`
- `rsvp_live_post_status=200`
- `result=PASS`

## CI/CD Integration Recommendation

Run contract-only mode in deployment pipeline after backend deploy:
1. Set `BACKEND_BASE_URL`
2. Execute smoke script
3. Fail pipeline on non-zero exit
4. Store output as deployment evidence

## Troubleshooting

1. Invalid-token checks not returning 401:
- Verify route path is `/api/v1/events/rsvp/:token`
- Confirm deployed backend is current

2. Live GET fails:
- Token may be expired or signed with a different secret

3. Live POST fails with role errors:
- Provide `RSVP_TEST_RESPONSE_ROLE` for responses requiring role context
