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

### Setup

1. Clone the repository
2. Set up Azure resources (see Azure deployment guide)
3. Install dependencies for frontend and backend
4. Configure environment variables
5. Run the application

## Development

- Frontend: `cd frontend && npm start`
- Backend: `cd backend && npm run dev`

## Deployment

Deployed via GitHub Actions to Azure.

## Contributing

See CONTRIBUTING.md for guidelines.

## License

Internal use only.