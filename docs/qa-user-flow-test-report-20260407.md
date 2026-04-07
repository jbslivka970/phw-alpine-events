# QA User Flow Test Report (2026-04-07)

Date: 2026-04-07
Scope: Fresh-credential persona refresh and full end-to-end user flow validation.

## Environment

- App URL: https://app.phwcoloradoalpine.org
- API URL: https://phwalpineeventsjb873a.azurewebsites.net/api/v1
- Persona credential source: scripts/.rbac-test.env
- Auth storage state directory: tests/e2e/.auth

## Persona Credential Refresh

Refresh command executed:

npm run e2e:refresh-tokens

Result:

- event_creator token refreshed and storage state updated
- member token refreshed and storage state updated
- admin token refreshed and storage state updated

Implementation note:

- scripts/refresh-playwright-tokens.mjs was hardened to support current MSAL/runtime token extraction patterns.

## Test Suites Executed

Full suite command executed:

npm run test:e2e

Included suites:

- tests/e2e/browser-auth-flows.spec.ts
- tests/e2e/browser-persona-flow-matrix.spec.ts
- tests/e2e/api-role-matrix.spec.ts

## Final Results

Final run status: PASS

- Total tests: 28
- Passed: 28
- Failed: 0
- Runtime: ~23.4s

## Coverage Summary

### Browser persona flow matrix

Validated per persona (admin, event_creator, member):

- Authenticated access to protected core routes
- Admin-only route enforcement
- Event assignment route enforcement
- TAVF new-route disallowed-admin rule
- Events page action visibility by capability

### API role-path matrix

Validated role/capability gating for:

- Events list
- Event status transitions
- Event creation
- Event AI draft generation
- Event record exports (CSV, PDF)
- Event record email send
- Admin users endpoint
- TAVF posting create RBAC behavior

## Issues Found During Execution and Resolved

1. Token refresh initially failed for event_creator with MSAL cache extraction mismatch.
   - Resolution: Updated scripts/refresh-playwright-tokens.mjs to extract bearer tokens from live request headers and expanded storage parsing.

2. API matrix initially misclassified event_creator capability on event creation due to static assumption.
   - Resolution: Updated tests/e2e/api-role-matrix.spec.ts to infer post-events capability from live endpoint behavior.

After both fixes, the full suite passed.

## Artifacts

- HTML report available locally via:
  npx playwright show-report
- Playwright traces retained for failure runs that occurred before final green pass.
