# PHW Alpine Events

Full-stack event management system for Project Healing Waters Colorado Alpine Chapter.

## Overview

This application provides a single platform for event creation, notification (email + SMS), RSVP collection, and attendance tracking for the PHW Colorado Alpine Chapter.

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript (Vite), MSAL for Azure AD B2C auth |
| Backend | Node.js 18 + TypeScript (Express) |
| Database | Azure SQL Database (T-SQL) |
| Notifications | Azure Communication Services (Email & SMS) — stubbed |
| Auth | Azure AD B2C |
| Deployment | Azure App Service (backend), Azure Static Web Apps (frontend) |

## Getting Started

### Prerequisites

- Node.js 18+
- [Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) (`brew install azure-cli` on macOS)
- Git

---

### 1 — Login to Azure

```bash
az login
az account set --subscription "<your-subscription-id>"
```

---

### 2 — Create Azure Resources

```bash
# Resource group
az group create \
  --name phw-alpine-rg \
  --location eastus

# Deploy all resources (SQL Server, SQL Database, App Service, ACS) via ARM template
az deployment group create \
  --resource-group phw-alpine-rg \
  --template-file deploy/azuredeploy.json \
  --parameters \
      appName=phw-alpine-events \
      sqlServerName=phw-alpine-sql \
      sqlAdminLogin=phwadmin \
      sqlAdminPassword="<YourStr0ngP@ssword>" \
      sqlDatabaseName=phw-alpine-db

# Retrieve the SQL Server FQDN (use as DB_HOST in .env)
az sql server show \
  --name phw-alpine-sql \
  --resource-group phw-alpine-rg \
  --query "fullyQualifiedDomainName" \
  --output tsv

# Retrieve ACS connection string (use as ACS_CONNECTION_STRING in .env)
az communication list-key \
  --name phw-acs \
  --resource-group phw-alpine-rg \
  --query "primaryConnectionString" \
  --output tsv
```

---

### 3 — Configure Environment Variables

```bash
# Backend
cp backend/.env.example backend/.env
# Edit backend/.env and fill in DB_HOST, DB_NAME, DB_USER, DB_PASSWORD,
# ACS_CONNECTION_STRING, ACS_EMAIL_FROM, ACS_SMS_FROM, and Azure AD B2C settings.

# Frontend
cp frontend/.env.example frontend/.env
# Edit frontend/.env and fill in VITE_AZURE_AD_B2C_CLIENT_ID, VITE_AZURE_AD_B2C_TENANT,
# VITE_API_BASE_URL, etc.
```

See [`backend/.env.example`](backend/.env.example) and [`frontend/.env.example`](frontend/.env.example)
for a full list of required variables.

**Required backend env vars** (the deploy-schema script exits immediately if any are missing):

| Variable | Description |
|----------|-------------|
| `DB_HOST` | Azure SQL Server FQDN, e.g. `phw-alpine-sql.database.windows.net` |
| `DB_PORT` | SQL port, default `1433` |
| `DB_NAME` | Database name, e.g. `phw-alpine-db` |
| `DB_USER` | SQL admin login |
| `DB_PASSWORD` | SQL admin password |
| `ACS_CONNECTION_STRING` | Azure Communication Services connection string |
| `ACS_EMAIL_FROM` | Verified sender email address |
| `ACS_SMS_FROM` | Verified E.164 SMS sender number |
| `AZURE_AD_B2C_CLIENT_ID` | B2C app client ID |
| `AZURE_AD_B2C_TENANT` | B2C tenant, e.g. `your-tenant.onmicrosoft.com` |
| `AZURE_AD_B2C_POLICY` | Sign-up/sign-in policy name |
| `AZURE_AD_B2C_ISSUER` | JWT issuer URL from B2C |

---

### 4 — Deploy Database Schema

The schema script is **idempotent** — safe to run multiple times. It uses `IF NOT EXISTS` guards so existing tables and data are never dropped.

```bash
cd backend
npm install
npm run deploy-schema
```

Expected output:
```
[deploy-schema] Connecting to Azure SQL Database...
[deploy-schema] Connected successfully.
[deploy-schema] Executing N SQL batch(es)...
[deploy-schema] Batch 1/N completed.
...
[deploy-schema] Schema deployed successfully (idempotent).
[deploy-schema] Connection closed.
```

The script will exit with code 1 and print the missing variable names if any required env vars are absent.

---

### 5 — Install Dependencies and Run Locally

```bash
# Backend
cd backend
npm install
npm run dev        # starts on http://localhost:3001

# Frontend (new terminal)
cd frontend
npm install
npm run dev        # starts on http://localhost:5173
```

---

### 6 — Build for Production

```bash
cd frontend && npm run build
cd ../backend && npm run build
```

---

## CI/CD

GitHub Actions workflow (`.github/workflows/ci-cd.yml`) runs on every push/PR to `main`:

1. Installs frontend and backend deps (`npm ci`)
2. Builds frontend (`vite build`)
3. Builds backend (`tsc`)
4. Deploys to Azure App Service (requires `AZUREAPPSERVICE_PUBLISHPROFILE` secret)

---

## Database Schema

`database/schema.sql` defines all production entities:

- **member** — PHW members imported from Salesforce or added manually
- **group** — mailing/notification groups (system: ALL, ADMIN, MENTORS, PARTICIPANTS)
- **member_group** — many-to-many join
- **app_user** — application admin/event-creator accounts backed by Azure AD B2C
- **event** — events with status workflow (DRAFT → PUBLISHED → COMPLETED/CANCELLED)
- **event_notification_target** — which groups/members an event invite was sent to
- **event_response** — RSVP records (YES/NO/MAYBE/WAITLIST) with group context
- **event_assignment** — confirmed mentor/participant slot fills
- **notification_log** — every email/SMS send attempt
- **sms_consent_log** — audit trail of opt-in / opt-out actions
- **import_log** — Salesforce CSV import history
- **notification_template** — reusable email/SMS message templates
- **take_a_vet_posting** — Take-A-Vet fishing trip postings

---

## License

Internal use only.

