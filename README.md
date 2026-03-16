# PHW Alpine Events

Full-stack event management system for Project Healing Waters Colorado Alpine Chapter.

## Overview

This application provides a single platform for event creation, notification (email + SMS), RSVP collection, and attendance tracking for the PHW Colorado Alpine Chapter.

## Architecture

- **Frontend:** React.js SPA
- **Backend:** Node.js with TypeScript
- **Database:** Azure SQL Database
- **Services:** Azure Communication Services (Email & SMS), Azure AD B2C, Azure Functions
- **Deployment:** Azure App Service, Azure Static Web Apps

## Getting Started

### Prerequisites

- Node.js 18+
- Azure CLI
- Git
- Personal GitHub account

### Setup

1. **Create GitHub Repository:**
   - Go to GitHub.com and create a new repository named `phw-alpine-events`
   - Do not initialize with README, .gitignore, or license
   - Copy the repository URL

2. **Push to GitHub:**
   ```bash
   git remote add origin <your-repo-url>
   git branch -M main
   git push -u origin main
   ```

3. **Set up Azure Resources:**
   - Install Azure CLI: `brew install azure-cli`
   - Login: `az login`
   - Create resource group: `az group create --name phw-alpine-rg --location eastus`
   - Deploy ARM template: `az deployment group create --resource-group phw-alpine-rg --template-file deploy/azuredeploy.json --parameters appName=phw-alpine-events sqlServerName=phw-alpine-sql sqlDatabaseName=phw-alpine-db`

4. **Configure Environment:**
   - Copy `.env.example` to `.env` in frontend and backend
   - Fill in Azure resource values from deployment outputs

5. **Install Dependencies:**
   ```bash
   cd frontend && npm install
   cd ../backend && npm install
   ```

6. **Run Locally:**
   - Backend: `cd backend && npm run dev`
   - Frontend: `cd frontend && npm run dev`

## Deployment

Configured for automatic deployment via GitHub Actions to Azure App Service.

## Contributing

See CONTRIBUTING.md for guidelines.

## License

Internal use only.
