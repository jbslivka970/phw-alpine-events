# Key Vault Migration Plan

Date: 2026-03-27
Owner: Engineering
Scope: LR-13 - Key Vault migration plan for sensitive app settings

## Objectives

- Move sensitive backend settings out of plain App Service app settings where feasible.
- Centralize secret rotation and access controls in Azure Key Vault.
- Reduce deployment risk by using phased migration with rollback checkpoints.

## Secrets In Scope

- DB_HOST
- DB_PORT
- DB_NAME
- DB_USER
- DB_PASSWORD
- ACS_CONNECTION_STRING
- ACS_EMAIL_FROM
- ACS_EMAIL_TO
- ACS_SMS_FROM
- AZURE_CLIENT_ID
- AZURE_TENANT_ID
- AZURE_AUTH_ISSUER
- AZURE_AUTH_JWKS_URI
- RSVP_TOKEN_SECRET

## Out Of Scope

- Non-sensitive toggles and intervals (for example JOBS_ENABLED, REMINDER_JOB_INTERVAL_MS, WAITLIST_JOB_INTERVAL_MS).
- Frontend build-time values that are already public by design.

## Prerequisites

1. Azure Key Vault created in the same subscription/resource group boundary as production App Service.
2. Managed Identity enabled for backend App Service.
3. Key Vault access policy or RBAC assignment grants `get` and `list` on secrets for App Service identity.
4. Existing app settings inventory exported and baseline checked.

## Migration Phases

### Phase 1 - Prepare

1. Create vault naming convention:
   - `kv-phw-alpine-prod`
2. Create secret naming convention:
   - lowercase with dashes (example `db-password`, `acs-connection-string`, `rsvp-token-secret`).
3. Add current secret values to Key Vault.
4. Record owners and rotation cadence for each secret.

### Phase 2 - App Service Wiring

1. Enable system-assigned managed identity on backend App Service.
2. Grant vault access to managed identity.
3. Replace sensitive App Service settings with Key Vault references:
   - `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/<version>)`
4. Keep original values in secure backup during transition window.

### Phase 3 - Validation

1. Restart backend App Service and verify startup:
   - `GET /api/v1/health/startup`
   - `GET /api/v1/health/ready`
2. Run smoke sequence:
   - backend health endpoints
   - auth-protected API route
   - `npm --prefix backend run smoke:all`
3. Validate notification channels in contract mode at minimum.

### Phase 4 - Rotation and Hardening

1. Rotate one low-risk secret (example RSVP token secret) and validate no runtime interruption.
2. Rotate DB password in coordinated window.
3. Document break-glass rollback (temporarily restore direct app settings values).
4. Add quarterly secret review checklist.

## Rollback Plan

1. Revert Key Vault reference app settings to previous direct values.
2. Restart backend App Service.
3. Re-run health and smoke checks.
4. Open incident log entry if rollback executed in production.

## Evidence Checklist

- Screenshot or export of managed identity assignment.
- Screenshot or export of Key Vault access role assignment.
- App Service settings diff before/after.
- Successful health checks and smoke run output after cutover.
- Rotation evidence for at least one secret.

## Risks and Mitigations

- Key Vault permission drift: mitigate with IaC or scripted RBAC validation.
- Secret reference typo causes startup errors: mitigate with staged slot verification before swap.
- Rotation without dependency coordination: mitigate with runbook and owner approvals.
