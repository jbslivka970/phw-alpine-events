# Backend Blue-Green + SQL Rollback Runbook

Date: 2026-04-14

## Why this exists

Backend deploys are currently in-place. Any startup regression or schema mismatch can cause visible outage while traffic is still routed to the same app instance.

This runbook defines a blue-green model for backend app code and an expand-contract model for SQL so rollback is practical.

## Core rules

1. Never combine destructive schema operations with first-wave code rollout.
2. New app version must run against both old and new schema during rollout window.
3. Rollback must be app-only for first response. Schema rollback is last resort.
4. Every migration must be idempotent and re-runnable.

## Target deployment model

1. Maintain two backend runtime environments:
- Blue (current production)
- Green (candidate)

2. Deploy candidate build to Green.

3. Run health + smoke checks against Green endpoint before traffic switch.

4. Shift traffic to Green (slot swap or traffic routing).

5. Keep Blue warm for fast rollback.

## SQL rollout model (expand-contract)

### Phase A: Expand (safe)

Allowed:
- Add nullable columns
- Add new tables
- Add additive indexes
- Add defaulted columns where old app remains compatible

Not allowed in Expand:
- Drop columns/tables
- Rename columns in place
- Narrow data types
- NOT NULL transitions without dual-write/read compatibility

### Phase B: App deploy

Deploy app that can:
- Read old and new schema safely
- Write both fields when dual-write is required

### Phase C: Backfill + verify

- Backfill asynchronously
- Verify reads/writes and analytics paths
- Confirm no old-app dependency remains

### Phase D: Contract (later release)

Only after one stable release cycle:
- Remove deprecated columns/tables
- Remove compatibility code

## Rollback strategy

### App rollback (primary)

1. Re-route traffic from Green back to Blue.
2. Keep schema at expanded state.
3. Re-run core smoke checks.

This is fast and avoids emergency SQL rollback.

### SQL rollback (exception path)

Only if migration itself corrupts compatibility:

1. Pause writes if needed.
2. Restore latest known-good DB backup to recovery target.
3. Re-point app to restored DB (or perform controlled data repair).
4. Re-run smoke checks.

## CI safety gates now in repo

1. Deploy safety flags check:
- scripts/ci/check-deploy-safety.mjs

2. Migration safety check:
- scripts/ci/check-migration-safety.mjs

The migration safety check blocks common breaking patterns unless explicitly annotated in SQL:

-- allow-breaking-migration: <CHECK_LABEL>

Use annotation only with explicit release note and rollback plan.

## Implementation status in repo

Implemented:

1. `.github/workflows/ci-cd.yml` backend deploy supports blue-green when `BACKEND_BLUE_GREEN_ENABLED=1`.
2. Pre-swap checks run against staging slot health + core compliance smokes.
3. Slot swap executes only on pre-swap success.
4. Post-swap checks run against production and auto-rollback executes on failure.
5. `.github/workflows/backend-rollback.yml` supports manual one-click swap-back.

Required setup for blue-green mode:

1. Create backend staging slot in Azure App Service.
2. Configure GitHub variables:
- `BACKEND_BLUE_GREEN_ENABLED=1`
- `AZURE_BACKEND_RESOURCE_GROUP`
- `AZURE_BACKEND_SLOT_NAME`
- optional `BACKEND_SLOT_BASE_URL`
3. Configure GitHub secrets:
- `AZURE_BACKEND_DEPLOY_CREDENTIALS`
- `RSVP_TEST_TOKEN`
4. Mark production-only app settings as slot-sticky in App Service slot configuration.
5. Keep SQL migrations in expand-contract mode so rollback remains app-first.

## Release checklist (backend)

1. Migration is Expand-only or explicitly approved.
2. CI build/test/Playwright/local safety gates pass.
3. Green slot health checks pass.
4. Green slot smoke checks pass.
5. Swap executed.
6. Post-swap smoke checks pass.
7. Blue slot retained for rollback window.
