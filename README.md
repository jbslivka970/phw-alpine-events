# PHW Alpine Events

Full-stack event management system for Project Healing Waters Colorado Alpine Chapter.

## Current Release Docs

- Wave 1 release lock and deploy record: `docs/wave-1-release-lock.md`
- Next-wave planning list: `docs/next-wave-task-list.md`

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

Set `WEBSITE_NODE_DEFAULT_VERSION` to `~20` for the Windows App Service. Do not pin it to an exact patch version like `20.20.0`; App Service expects a supported installed runtime selector, and an invalid value can leave the site returning HTTP 500 before the app starts.

## CI/CD

The pipeline lives in `.github/workflows/ci-cd.yml`.

- `build` installs and compiles the frontend and backend
- `deploy` assembles the backend deployment package and pushes it to Azure App Service on pushes to `main`

### Required GitHub Variables

- `AZURE_WEBAPP_NAME`

### Required GitHub Secrets

- `AZUREAPPSERVICE_PUBLISHPROFILE`

If `AZURE_WEBAPP_NAME` is not configured, the deploy job is skipped and the workflow behaves as build-only validation.

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
- `ACS_SMS_FROM`
- `AZURE_AD_B2C_TENANT_NAME`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_AD_B2C_POLICY_NAME`
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

## Production Plumbing Checklist

Backend App Service settings required for full functionality:

- `NODE_ENV=production`
- `WEBSITE_NODE_DEFAULT_VERSION=~20`
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
- `ACS_SMS_FROM`
- `WAITLIST_JOB_INTERVAL_MS`
- `APPINSIGHTS_INSTRUMENTATIONKEY` or `APPLICATIONINSIGHTS_CONNECTION_STRING`

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
