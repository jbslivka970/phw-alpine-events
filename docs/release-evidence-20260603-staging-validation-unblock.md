# Release Evidence: 2026-06-03 Staging Validation Unblock

## Scope
- Unblock staging startup health for multi-tenant validation.
- Confirm tenant denial contract and Playwright staging validation.
- Re-check Kudu/SCM authentication paths after policy and credential updates.

## Baseline
- Branch head before this implementation cycle: `31fb32a`.
- Latest successful CI/CD run for that head: `26892615869`.
- Related successful security runs:
  - CodeQL: `26892611743`
  - DAST baseline: `26892615952`
  - DAST authenticated: `26894097799`

## Blocker Observed
- Staging `GET /api/v1/health/startup` returned `503`.
- Diagnostic payload reported ARM authorization failure for appsettings list:
  - Action: `Microsoft.Web/sites/config/list/action`
  - Principal: staging runtime managed identity
  - Effect: key-vault reference check downgraded to runtime path and reported missing references.

## Remediation Applied
- Resource: backend app `phwalpineeventsjb873a` (staging slot identity principal id `d05f7d25-c0d2-4e47-81b7-708e9c5614a9`).
- RBAC assignment:
  - Role: `Website Contributor`
  - Scope: `/subscriptions/1b23695a-dfdf-4ccd-839d-dfa515ae873a/resourceGroups/phw-alpine-rg-westus2/providers/Microsoft.Web/sites/phwalpineeventsjb873a`
  - Assignment id: `f51efa74-8730-4092-8e23-b13014d8f7fd`
- Restarted staging slot after role assignment.

## Post-Remediation Verification
- Staging health:
  - `GET /api/v1/health` -> `200`
  - `GET /api/v1/health/startup` -> `200`
  - Startup diagnostics: `keyVaultReferencesConfigured=true`, source `arm`, no missing references.

- Tenant denial contract (live tokenized checks against staging):
  - admin: baseline `/events` `200`, forced inaccessible tenant header `200` (root bypass expected)
  - event_creator: baseline `/events` `200`, forced inaccessible tenant header `403`
  - member: baseline `/events` `200`, forced inaccessible tenant header `403`

- Playwright staging suite:
  - Command: `npm run test:e2e:tenant-denial`
  - Result: `3 passed`.

## SCM/Kudu Re-Check
- Backend staging SCM latest deployment endpoint auth:
  - HTTP `200`, deployment complete.
- Frontend staging:
  - `basicPublishingCredentialsPolicies/scm.allow=true`
  - SCM latest deployment endpoint auth with list-publishing-credentials: HTTP `200`
  - SCM latest deployment endpoint auth with publish-profile credentials: HTTP `200`

## Current State
- Production remains healthy:
  - `GET /api/v1/health` -> `200`
  - `GET /api/v1/health/startup` -> `200`
  - key-vault reference check source `arm` with no missing references.
- Staging is now ready for continued validation tests and real-user testing preparation.

## Remaining Risk Notes
- Keep startup health probe as required gate before slot swap.
- Keep tenant denial matrix as release gate using expected contract:
  - admin forced inaccessible tenant header `200`
  - event_creator/member forced inaccessible tenant header `403`.
- Preserve SCM credential fallback knowledge: publish-profile credentials remain a valid fallback if list-publishing-credentials ever regress.
