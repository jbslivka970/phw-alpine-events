# Wave 1 Release Lock

Date: 2026-03-19
Branch: main
Release commit: 4c7bd97

## Scope Locked

- RSVP channel tracking and group-context persistence
- Reminder idempotency and reminder state tracking
- Notification fanout behavior validated for per-group sends without dedupe
- Frontend wave 1 UI polish updates
- Database schema updates required by wave 1 behavior
- Expanded backend regression tests

## Merge and Push Status

- Commit 4c7bd97 pushed to origin/main
- Local branch status after push: main aligned with origin/main
- Historical local branches remain for reference and can be cleaned up in a separate branch hygiene pass

## Deployment Status

Frontend App Service:
- App: phwalpineeventsfe873a
- Deploy method: Azure App Service OneDeploy zip
- Deployment id: b0cee338a89544c592ca5b3867389040
- Result: Succeeded

Backend App Service:
- App: phwalpineeventsjb873a
- Deploy method: Azure App Service OneDeploy zip
- Initial package timed out due artifact size/layout, resolved by lean root-structured package
- Deployment id: de905b7d06b34bf6a81ff8c7a5f3f011
- Result: Succeeded

## Post-Deploy Smoke Checks

- GET /api/v1/health -> 200
- GET /api/v1/health/ready -> 200
- GET /api/v1/health/startup -> 200
- GET frontend / -> 200
- GET frontend /privacy -> 200

## Artifacts

Generated deployment zip artifacts were archived outside the repository to keep git clean.
