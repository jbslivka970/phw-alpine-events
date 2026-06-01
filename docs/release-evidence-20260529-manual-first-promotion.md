# Release Evidence - Manual First Promotion (2026-05-29)

## Scope

- SQL-first production rollout for multi-tenant slice updates.
- Staging to production swap.
- Production post-swap recovery validation.
- Production smoke checks.
- Staging rehydrate to current build.

## Environment

- App Service: phwalpineeventsjb873a
- Resource Group: phw-alpine-rg-westus2
- Slots: production, staging

## Promotion Summary

1. Production DB schema and invariants were checked and corrected before swap.
2. Staging was promoted to production by slot swap.
3. Production startup briefly showed degraded Key Vault reference status; direct production restart recovered startup to 200.
4. Contract-mode smoke checks passed in production.
5. Config drift guard was added by making DB_PASSWORD slot-sticky.
6. Staging was rehydrated to the current backend build after swap.

## Verified Outcomes

### Production checks

- GET /api/v1/health -> 200
- GET /api/v1/me/tenants -> 401 (expected unauthenticated response, route present)
- GET /api/v1/health/startup -> 200 after restart
- Startup key-vault gate snapshot:
  - keyVaultReferencesConfigured=true
  - requireKeyVaultReferences=true
  - missing.keyVault=[]

### Production smoke suite (contract mode)

- smoke:sms -> PASS
- smoke:email -> PASS
- smoke:rsvp -> PASS
- smoke:ai -> PASS
- smoke:redis -> PASS (provider=redis, redis_connected=true)

### Config drift lock

- DB_PASSWORD is now configured as slot-sticky.
- Slot config verification: appSettingNames includes DB_PASSWORD.
- Production and staging DB_PASSWORD values both point to Key Vault reference:
  - @Microsoft.KeyVault(SecretUri=https://kv-phw-alpine-prod.vault.azure.net/secrets/db-password/)

### Staging rehydrate

- Initial large-bundle zipdeploy attempts timed out with HTTP 408 at upload.
- Slim zipdeploy succeeded:
  - upload_code=202
  - deploy_id=f886919d90914cd980bd3bfd5c2b0fa1
  - deployment status=4 (success)
- Post-rehydrate staging probes:
  - GET /api/v1/health -> 200
  - GET /api/v1/me/tenants -> 401 (expected unauthenticated response, route present)

## Notable incidents during release

1. Large zipdeploy upload to staging returned HTTP 408; recovered by deploying slim source bundle.
2. Production startup degraded on Key Vault reference gate immediately post-swap; recovered with direct production restart.

## Follow-on implementation kickoff (Step 5)

- Frontend API client now supports active tenant propagation via X-Tenant-Id from localStorage.
- New frontend me API module added for GET /me/tenants integration groundwork.
- Tenant provider and route-gating flow now enforce tenant selection/no-access routing and tenant-aware branding.
- Added `/tenant/select` picker UX, no-access fallback view, and Login redirect behavior based on tenant context state.
- Frontend verification tests added for tenant provider behavior and Login redirect routing.

## Frontend deployment evidence (Step 5 slice)

- Commit deployed: `caa4b1d` (frontend tenant UX slice).
- Direct full-package frontend deploy attempts failed in this environment due transport constraints:
  - Kudu upload of ~100 MB package returned `HTTP 408 RequestTimeout`.
  - `az webapp deploy` failed with local trust-chain error (`CERTIFICATE_VERIFY_FAILED`).
- Successful release path used Kudu publish overlay package with unchanged large photo corpus excluded from upload payload:
  - Overlay package size: `3,461,136` bytes.
  - Kudu publish endpoint response: `HTTP 200`.
- Post-deploy probes:
  - GET `/` -> 200
  - GET `/login` -> 200
  - GET `/tenant/select` -> 200
- Live bundle verification:
  - Root HTML references `main-CfEN6ZhO.js` (new frontend build hash present in production).
