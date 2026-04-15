# PHW Alpine Events

Full-stack event management system for Project Healing Waters Colorado Alpine Chapter.

## Current Release Docs

- Wave 1 release lock and deploy record: `docs/wave-1-release-lock.md`
- Next-wave planning list: `docs/next-wave-task-list.md`
- PRD implementation compare and remaining gaps: `docs/prd-v1_1-full-compare-20260320.md`

Current top priorities are operational sign-off items: retention policy rollout, template governance evidence cadence, and recurring production compliance smoke evidence.

## Overview

This application supports member management, event publishing, RSVP collection, and chapter operations for the Colorado Alpine Chapter. The current repository baseline now includes:

- an Azure SQL schema aligned with the current PRD model
- an Express backend with versioned routes under `/api/v1`
- Azure AD B2C JWT validation and RBAC middleware on the backend
- a React and Vite frontend shell with MSAL-based sign-in scaffolding

## Architecture

- **Frontend:** React 18 SPA built with Vite
- **Backend:** Node.js 18, TypeScript, Express
- **Database:** Azure SQL Database
- **Auth:** Azure AD B2C with MSAL on the frontend and JWT validation on the backend
- **Notifications:** Azure Communication Services for email and SMS workflows
- **Deployment:** GitHub Actions to Azure Windows App Service through IISNode

## Live Environment

- **Region:** `westus2`
- **Resource Group:** `phw-alpine-rg-westus2`
- **App Service:** `phwalpineeventsjb873a`
- **Live URL:** `https://phwalpineeventsjb873a.azurewebsites.net`

The root endpoint currently responds with JSON and advertises the API base. Application routes are versioned under `/api/v1`.

## Windows App Service Runtime

The backend is deployed to a **Windows** App Service plan and runs through IISNode.

Deployment depends on these backend files staying in sync:

```text
backend/server.js
backend/web.config
backend/dist/
backend/package.json
backend/package-lock.json
backend/node_modules/
```

`server.js` is the Node entrypoint used by IISNode and `web.config` contains the rewrite rules that prevent the App Service from returning a 403 at the root. Do not remove or rename those files without updating the deployment model.

Set `WEBSITE_NODE_DEFAULT_VERSION` to `~22` for the Windows App Service. Do not pin it to an exact patch version; App Service expects a supported installed runtime selector, and an invalid value can leave the site returning HTTP 500 before the app starts.

## CI/CD

The pipeline lives in `.github/workflows/ci-cd.yml`.

- `build` installs and compiles the frontend and backend
- `build` runs frontend lint, backend typecheck, backend compile, test-suite sanity checks, and backend tests
- `deploy` assembles the backend deployment package and pushes it to Azure App Service on pushes to `main`
- `deploy` supports two backend modes:
  - direct mode (default): Kudu zipdeploy to production
  - blue-green mode (`BACKEND_BLUE_GREEN_ENABLED=1`): deploy to slot, run slot smokes, swap, run post-swap smokes, auto-rollback on failure
- `deploy_frontend` builds the frontend and deploys `frontend/dist` to the frontend Azure App Service on pushes to `main`
- `deploy` runs core post-deploy compliance smokes (`email` + `rsvp`) as required gates
- `deploy` runs SMS post-deploy smoke only when enabled via variables
- `.github/workflows/backend-rollback.yml` provides a manual one-click backend swap-back workflow

### Required GitHub Variables

- `AZURE_WEBAPP_NAME`
- `BACKEND_BLUE_GREEN_ENABLED` (optional, set to `1` to enable slot-based backend deploy)
- `AZURE_BACKEND_RESOURCE_GROUP` (required when blue-green is enabled)
- `AZURE_BACKEND_SLOT_NAME` (required when blue-green is enabled)
- `BACKEND_SLOT_BASE_URL` (optional slot URL override; defaults to `https://<app>-<slot>.azurewebsites.net`)
- `AZURE_FRONTEND_WEBAPP_NAME`
- `AZURE_FRONTEND_RESOURCE_GROUP`
- `VITE_EXTERNAL_CLIENT_ID`
- `VITE_EXTERNAL_TENANT_ID`
- `VITE_EXTERNAL_TENANT_NAME`
- `VITE_API_SCOPE`
- `VITE_API_BASE_URL`
- `SMS_SMOKE_ENABLED` (optional, set to `1` to run SMS smoke in non-blocking mode)
- `SMS_COMPLIANCE_REQUIRED` (optional, set to `1` to make SMS smoke a blocking deploy gate)

### Required GitHub Secrets

- `AZUREAPPSERVICE_PUBLISHPROFILE`
- `AZURE_BACKEND_DEPLOY_CREDENTIALS` (required when blue-green is enabled or for manual rollback)
- `AZURE_FRONTEND_DEPLOY_CREDENTIALS`
- `RSVP_TEST_TOKEN` (required for blue-green pre-swap and post-swap live RSVP checks)
- `COMPLIANCE_ALERT_WEBHOOK_URL` (optional; receives a webhook when required compliance gates fail)

If `AZURE_WEBAPP_NAME` is not configured, the backend deploy job is skipped.
If `AZURE_FRONTEND_WEBAPP_NAME` or the required `VITE_*` variables are not configured, the frontend deploy job is skipped.
In both cases, the workflow still runs build and test validation.

## Standalone Splash Site

The repository also contains a standalone marketing splash site in `splash/` for `www.phwcoloradoalpine.org`.

- Source and host configs: `splash/`
- Splash validation workflow: `.github/workflows/splash-validate.yml`
- Azure deploy workflow: `.github/workflows/splash-deploy-azure-webapp.yml`
- Splash smoke workflow: `.github/workflows/splash-smoke.yml`
- GitHub Pages deploy workflow: `.github/workflows/splash-deploy-pages.yml`

See `splash/README.md` for DNS records and go-live steps.

## Local Development

### Prerequisites

- Node.js 20+
- Git
- Azure CLI if you need to provision or inspect Azure resources

### Install Dependencies

```bash
cd frontend && npm ci
cd ../backend && npm ci
```

### Backend Environment

Copy `backend/.env.example` to `backend/.env` and set the values for your environment.

Key backend variables:

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `ACS_CONNECTION_STRING`
- `ACS_EMAIL_FROM`
- `ACS_EMAIL_TO` (optional comma-separated To-line addresses for regional admin dispatch)
- `EVENT_RECORD_EMAIL_TO` (optional comma-separated recipients for Events -> Email Record; defaults to `ACS_EMAIL_TO` when unset)
- `TELNYX_API_KEY` (recommended for SMS)
- `TELNYX_MESSAGING_PROFILE_ID` (recommended with Telnyx)
- `TELNYX_FROM_NUMBER` (optional when messaging profile is configured)
- `TWILIO_ACCOUNT_SID` (optional SMS fallback provider)
- `TWILIO_AUTH_TOKEN` (optional SMS fallback provider)
- `TWILIO_MESSAGING_SERVICE_SID` (optional SMS fallback provider)
- `ACS_SMS_FROM` (legacy SMS fallback metadata only)
- `AZURE_AD_B2C_TENANT_NAME`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_AD_B2C_POLICY_NAME`
- `AUTH_ENFORCE_MEMBER_PASSWORDLESS` (recommended: `true`)
- `AUTH_LOCAL_PASSWORD_ALLOWLIST` (comma-separated emails allowed for local password, admin/smoke only)
- `CORS_ORIGIN`
- `NODE_ENV`
- `PORT`

### Frontend Environment

Copy `frontend/.env.example` to `frontend/.env`.

Key frontend variables:

- `VITE_AZURE_AD_B2C_TENANT_NAME`
- `VITE_AZURE_TENANT_ID`
- `VITE_AZURE_CLIENT_ID`
- `VITE_AZURE_AD_B2C_POLICY_NAME`
- `VITE_AZURE_AUTHORITY` (optional override)
- `VITE_API_BASE_URL` (optional when using local Vite proxy)

### Run Locally

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

The backend listens on `http://localhost:3001` by default. The frontend runs through Vite and currently exposes the authenticated shell, placeholder pages, and role-gated navigation.

For local frontend API calls, Vite proxies `/api/*` to `http://localhost:3001`.

### Frontend Flow Regression Pattern

Use this to run a focused frontend flow suite before merges or deploys:

```bash
cd frontend && npm run test:flows
```

This suite currently validates the TAVF detail page paths that have recently regressed:

- admin load path (posting + applications + matches)
- confirm match request shape (no `matched_by` leakage from auth subject)
- backend 500 surfacing in UI during match confirmation
- non-admin apply flow request payload

It also validates Events flow paths:

- create-event modal payload normalization and submission
- edit-event save path with update reason
- cancel status transition path from event cards
- API delete contract (`DELETE /events/:id`) to guard endpoint wiring

Import flow coverage included in the same command:

- shared-email conflict table rendering in CSV preview
- default conflict decision (`skip`) and explicit override (`create`)
- commit payload includes row-level conflict resolutions

For full frontend unit/integration tests:

```bash
cd frontend && npm test
```

### V2 Local Release Validation (Recommended)

For V2 pre-release checks, use the single-command local validation runner:

```bash
npm run test:v2:local:quick
```

Quick mode runs:
- frontend lint
- frontend flow regression tests
- backend typecheck
- backend targeted CI suites (`events`, `rsvpService`, `notifications`, `aiInviteService`, `reminderJob`)

Full mode (adds backend full coverage run and optional Playwright API role matrix):

```bash
npm run test:v2:local
```

The local runner script is [scripts/local-v2-validation.sh](scripts/local-v2-validation.sh).

Behavior notes:
- If `BACKEND_BASE_URL` is reachable (default `http://localhost:3001`), it runs local `smoke:email` and `smoke:rsvp`.
- If backend is not running, smoke scripts are skipped with guidance.
- If `E2E_API_BASE_URL` and `E2E_APP_URL` are set, full mode runs Playwright role matrix with those endpoints.
- If E2E vars are not set, full mode runs deterministic local Playwright API + browser suites in bypass mode (`E2E_LOCAL_AUTH_ENABLED=1`) against `http://localhost:3001` and `http://localhost:5173`.

### Backend Coverage

Generate backend coverage locally:

```bash
cd backend && npm run test:coverage
```

CI-style serial coverage run:

```bash
cd backend && npm run test:coverage:ci
```

### Playwright Role-Matrix Regression Suite

Use this for authenticated API path regression checks across roles:

```bash
npm run test:e2e:role-matrix
```

Local no-credential mode (deterministic role tokens + local auth bypass):

```bash
E2E_LOCAL_AUTH_ENABLED=1 E2E_API_BASE_URL=http://localhost:3001 E2E_APP_URL=http://localhost:5173 npm run test:e2e:role-matrix
```

For browser Playwright suites in local no-credential mode, start backend with `E2E_LOCAL_AUTH_ENABLED=1` so Bearer tokens like `e2e-admin` are accepted.
This bypass mode is hard-disabled in production even if the flag is accidentally set.

For browser route validation with credential-based login (Preferences + TAVF paths):

```bash
npm run test:e2e:browser
```

For full API + browser suite:

```bash
npm run test:e2e
```

For full local API + browser suite without Entra credentials:

```bash
npm run test:e2e:local
```

Before running on demand, refresh short-lived tokens and storage state:

```bash
E2E_APP_URL=https://phwalpineeventsfe873a.azurewebsites.net \
PW_EVENT_CREATOR_USER=<upn> PW_EVENT_CREATOR_PASS=<password> \
PW_MEMBER_USER=<upn> PW_MEMBER_PASS=<password> \
PW_ADMIN_USER=<upn> PW_ADMIN_PASS=<password> \
npm run e2e:refresh-tokens
```

Required environment variables:

- `E2E_API_BASE_URL` (for example `https://phwalpineeventsjb873a.azurewebsites.net/api/v1`)
- `E2E_APP_URL` (for example `https://phwalpineeventsfe873a.azurewebsites.net`)

Required credential variables for refresh script:

- `PW_EVENT_CREATOR_USER`, `PW_EVENT_CREATOR_PASS`
- `PW_MEMBER_USER`, `PW_MEMBER_PASS`

Optional credential variables:

- `PW_ADMIN_USER`, `PW_ADMIN_PASS`

Token variables are generated automatically by refresh script (or can be pre-supplied):

- `PW_EVENT_CREATOR_TOKEN`
- `PW_MEMBER_TOKEN`
- `PW_ADMIN_TOKEN`

This suite guards recent production regressions by asserting:

- table-driven role x endpoint permission contracts across `/events`, `/events/:id/status`, `/admin/users`, and `/tavf/postings`
- authenticated calls to `PUT /events/:id/status` are not blocked by `401/403` for valid roles
- TAVF posting create no longer fails UUID-validation when stale clients send legacy guide IDs
- browser-level authenticated paths for `/preferences` and `/tavf/new` using live credential login
- preferences page only calls member detail APIs with UUID member IDs and never surfaces Invalid GUID errors

Notification preference behavior:

- `/preferences` now supports self-service channel modes: `email_only`, `sms_only`, and `both`.
- Preference updates write through to member `sms_opt_in` and `email_opt_out` flags.
- SMS-enabled selections require a mobile phone on file.

CI trigger strategy for a lighter dev process:

- PRs and main pushes run build, backend tests, and frontend regression-flow tests.
- Full Playwright role matrix + browser flows run only on version tag pushes (`v*`), release publication, or manual workflow dispatch.
- Release publication also runs compliance smoke checks against production backend endpoints.

## Production Plumbing Checklist

Backend App Service settings required for full functionality:

- `NODE_ENV=production`
- `WEBSITE_NODE_DEFAULT_VERSION=~22`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `AZURE_AD_B2C_TENANT_NAME`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_AD_B2C_POLICY_NAME` (optional if default policy name is used)

Optional backend settings:

- `ACS_CONNECTION_STRING`
- `ACS_EMAIL_FROM`
- `ACS_EMAIL_TO`
- `TELNYX_API_KEY` (preferred SMS provider)
- `TELNYX_MESSAGING_PROFILE_ID` (or `TELNYX_FROM_NUMBER`)
- `TELNYX_FROM_NUMBER` (optional when messaging profile is used)
- `TWILIO_ACCOUNT_SID` (fallback SMS provider)
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID`
- `ACS_SMS_FROM` (legacy SMS sender metadata)
- `WAITLIST_JOB_INTERVAL_MS`
- `APPINSIGHTS_INSTRUMENTATIONKEY` or `APPLICATIONINSIGHTS_CONNECTION_STRING`
- `OPENAI_API_KEY` (for AI invite generation)
- `OPENAI_MODEL` (optional override; default `gpt-4.1-mini`)
- `RETENTION_JOB_ENABLED` (set `true` to enable scheduled log-retention cleanup)
- `RETENTION_JOB_INTERVAL_MS` (job cadence; default 24h)
- `RETENTION_DRY_RUN` (set `true` to count rows only, no deletes)
- `RETENTION_CONFIRM_DELETE` (must be `true` to allow delete mode; otherwise job auto-falls back to dry-run)
- `RETENTION_MAX_DELETE_PER_TARGET` (safety cap per target in delete mode; default `50000`)
- `RETENTION_NOTIFICATION_LOG_DAYS` (default `180`)
- `RETENTION_INBOUND_SMS_LOG_DAYS` (default `365`)
- `RETENTION_EMAIL_PREFERENCE_LOG_DAYS` (default `365`)

Optional CI/CD secret:

- `COMPLIANCE_ALERT_WEBHOOK_URL` webhook endpoint (Teams/Slack/custom) notified when post-deploy compliance smokes fail on `main`
- `PW_EVENT_CREATOR_USER`, `PW_EVENT_CREATOR_PASS` credentials for Playwright token refresh
- `PW_MEMBER_USER`, `PW_MEMBER_PASS` credentials for Playwright token refresh
- `PW_ADMIN_USER`, `PW_ADMIN_PASS` optional admin credentials for admin-only contract coverage

Optional CI/CD variable:

- `E2E_API_BASE_URL` base API URL used by Playwright role-matrix checks

### AI Feature Setup

The preferred AI setup for this application is Azure OpenAI. The backend invite generator will use Azure OpenAI first when configured, then fall back to the public OpenAI API if those credentials are set, and finally fall back to deterministic invite copy if neither AI provider is configured.

Preferred Azure OpenAI settings:

```bash
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<your-azure-openai-api-key>
AZURE_OPENAI_DEPLOYMENT=<your-chat-model-deployment-name>
AZURE_OPENAI_API_VERSION=2024-10-21
```

Optional public OpenAI compatibility settings:

```bash
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-4.1-mini
```

If no AI provider is configured, the app still works and automatically falls back to deterministic invite copy.

Current AI-related capabilities:

- Admin invite draft generation through `/api/admin/ai/invite-draft`
- Admin template apply flow through `/api/admin/ai/invite-draft/apply`
- Deterministic assignment equity recommendations through `/api/events/:id/assignment-recommendations`

Current validation status:

- Backend unit tests cover Azure OpenAI, public OpenAI, provider precedence, and deterministic fallback behavior for invite draft generation.
- Frontend shows whether a generated invite came from `azure-openai`, `openai`, or `fallback` provider.

Quick enablement checklist for production:

1. Add `AZURE_OPENAI_ENDPOINT` to backend App Service settings.
2. Add `AZURE_OPENAI_API_KEY`.
3. Add `AZURE_OPENAI_DEPLOYMENT`.
4. Optionally add `AZURE_OPENAI_API_VERSION`.
5. Restart the backend app.
6. Open Admin → AI Invite Draft and confirm the provider shows `azure-openai`.
7. Generate and review one invite draft before enabling wider operational use.

Public OpenAI compatibility path:

1. Add `OPENAI_API_KEY`.
2. Optionally add `OPENAI_MODEL`.
3. Restart the backend app.
4. Open Admin → AI Invite Draft and confirm the provider shows `openai`.

If you want Azure OpenAI, you do not need a public OpenAI key.
- `E2E_APP_URL` frontend base URL used for browser-authenticated route checks

Operational guidance:

- Template governance and approval policy: `docs/template-governance-policy.md`
- PRD gap tracker: `docs/prd-v1_1-full-compare-20260320.md`

Admin retention governance:

- Use `POST /api/v1/admin/retention/preview` to generate dry-run retention evidence before enabling delete mode.
- Optional request body fields: `notification_log_days`, `inbound_sms_log_days`, `email_preference_log_days`, `format` (`json` or `csv`).

## Smoke Test Sequence

1. Verify app process and API root:
  - `GET /`
  - `GET /api/v1/health`
2. Verify startup configuration diagnostics:
  - `GET /api/v1/health/startup`
3. Verify database readiness:
  - `GET /api/v1/health/ready`
4. Verify auth plumbing:
  - Unauthenticated `GET /api/v1/events` should return `401` when auth is configured.
  - If it returns `503 Authentication is not configured`, auth env vars are still missing.
5. Verify authenticated flow in UI:
  - Login succeeds via B2C
  - Dashboard loads
  - Events, Calendar, Reports, Members routes load without API auth errors

## Database Schema Deployment

The schema is stored in `database/schema.sql`.

To apply it to a configured Azure SQL database:

```bash
cd backend
npm run deploy-schema
```

That script reads the SQL file and executes it against the database defined by the `DB_*` environment variables.

## Azure Provisioning

Infrastructure bootstrap is stored in `deploy/azuredeploy.json`.

Example deployment flow:

```bash
az login
az group create --name phw-alpine-rg-westus2 --location westus2
az deployment group create \
  --resource-group phw-alpine-rg-westus2 \
  --template-file deploy/azuredeploy.json \
  --parameters appName=<app-name> sqlServerName=<sql-server-name> sqlDatabaseName=<db-name>
```

After provisioning, download the App Service publish profile and store it in the repository secret `AZUREAPPSERVICE_PUBLISHPROFILE`.

## Microsoft Entra External ID Setup

Effective May 1, 2025, Azure AD B2C is no longer available for new customer purchases. Use Microsoft Entra External ID for new deployments.

Use this flow to provision identity for production/staging.

1. Create or select an External ID tenant (Azure Portal).
2. Link the External ID tenant to your subscription resource group.
3. In that tenant, create app registrations:
  - Backend API app registration
  - Frontend SPA app registration
4. In backend app registration:
  - Set Application ID URI (for example `api://<backend-app-id>`)
  - Add delegated scope (for example `access_as_user`)
5. In frontend app registration:
  - Add SPA redirect URI for your frontend origin
  - Grant API permission to backend scope
6. Create sign-up/sign-in user flow (for example `B2C_1_signupsignin`, or your chosen flow name).

When you have the External ID values, apply backend App Service auth settings with:

`./scripts/configure-external-id-appsettings.sh --resource-group <rg> --webapp <webapp> --tenant-name <tenant-name> --tenant-id <tenant-id> --backend-client-id <backend-app-id> --frontend-client-id <frontend-app-id> --authority <authority-base-url> --issuer <issuer-url> --jwks-uri <jwks-url> --policy-name B2C_1_signupsignin`

Then set frontend environment values in your frontend host using the printed `VITE_*` outputs from the script.

## License

Internal use only.
