# Production Lock: Working Mode Runbook

Date: 2026-06-04
Release Target: v6.0.0

This is the minimal, do-not-skip sequence for hardening production right after deployment completes.

## 1) Create code snapshot (rollback anchor)

Run from repo root:

```bash
npm run release:code-snapshot -- 6.0.0
```

Expected output artifacts:

- artifacts/release/code-snapshot-v6.0.0-<timestamp>-<sha>.bundle
- artifacts/release/code-snapshot-v6.0.0-<timestamp>-<sha>.zip
- artifacts/release/code-snapshot-v6.0.0-<timestamp>-<sha>.manifest.txt

## 2) Create full DB backup export (BACPAC)

Set environment variables and run:

```bash
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export AZURE_SQL_RESOURCE_GROUP="<resource-group>"
export AZURE_SQL_SERVER="<sql-server-name>"
export AZURE_SQL_DATABASE="<database-name>"
export AZURE_STORAGE_URI="https://<storage-account>.blob.core.windows.net/<container>/<file>.bacpac"
export AZURE_STORAGE_KEY="<storage-account-key>"
export SQL_ADMIN_USER="<sql-admin-user>"
export SQL_ADMIN_PASSWORD="<sql-admin-password>"

npm run release:db-backup-export
```

Gate:

- BACPAC export appears in the target storage path.
- Export timestamp and URI are recorded in release evidence.

## 3) Run targeted tenant isolation smoke checks

Backend isolation regression:

```bash
cd backend && npm test -- events.test.ts groups.test.ts members.test.ts tavf.test.ts resolveTenantContext.test.ts
```

Post-deploy browser smoke:

```bash
cd .. && npm run release:postdeploy-smoke
```

Gate:

- All targeted suites pass.
- No cross-tenant leakage in dashboard/events/groups/members/TAVF paths.

## 4) Release commit/tag confirmation

- Confirm manifests are at 6.0.0:
  - backend/package.json
  - frontend/package.json
  - deploy-package/package.json
- Ensure CI/CD workflow succeeds on main (build + deploy + smoke gates).

## 5) If rollback is needed

- App rollback first: use backend slot swap-back workflow.
- Data rollback second: restore from BACPAC/point-in-time backup if required.
