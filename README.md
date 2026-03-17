# PHW Alpine Events

Full-stack event management system for Project Healing Waters Colorado Alpine Chapter.

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

- Node.js 18+
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
- `VITE_API_BASE_URL`

### Run Locally

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

The backend listens on `http://localhost:3001` by default. The frontend runs through Vite and currently exposes the authenticated shell, placeholder pages, and role-gated navigation.

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

## License

Internal use only.
