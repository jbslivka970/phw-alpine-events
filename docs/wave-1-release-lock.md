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

## Production Bug Response Playbook

Primary objective:
- Restore member-facing reliability first, then diagnose root cause.

Severity levels:
- P0: Login failure, RSVP failure, notification delivery outage, data loss/corruption.
- P1: Core workflow degraded but workaround exists.
- P2: Non-blocking defects, UI polish, low-impact edge cases.

Ownership and SLA:
- Incident commander: Release owner on call.
- First acknowledgement: 10 minutes for P0/P1.
- Triage decision (fix-forward vs rollback): 20 minutes for P0.
- User-facing status update cadence: every 30 minutes until resolved.

Triage flow (prescriptive):
1. Capture failing URL, user identity, role, event id, timestamp (UTC), screenshot.
2. Check health probes and deployment status first.
3. Reproduce on production with least-privileged account.
4. Classify as P0/P1/P2 and open incident issue.
5. Choose action:
- Fix-forward when blast radius is contained and patch ETA is under 60 minutes.
- Rollback when blast radius is broad or diagnosis is uncertain.
6. Run required post-action smoke checks before close.

Rollback triggers (hard rules):
- Two consecutive failed deploy smoke runs for same change.
- Any P0 persisting more than 30 minutes.
- Error-rate spike with member impact and no deterministic fix in progress.

Required closeout for every P0/P1:
- Root cause summary.
- Detection gap noted.
- Test gap mapped to exact missing or flaky test.
- Follow-up task with owner and due date.

## 48-Hour Stabilization Checklist

T+0 to T+2 hours:
- Confirm CI/CD deploy completion and health probes green.
- Run manual critical journeys:
- Member login -> Dashboard -> My RSVPs visible.
- Member RSVP update on Events page persists.
- TAVF preference toggle persists across reload.
- Verify one outbound email and one SMS log entry for expected test recipient.

T+2 to T+12 hours:
- Review notification and RSVP error logs every 2 hours.
- Track top 5 production exceptions by count and endpoint.
- Patch only P0/P1 defects; defer P2 unless trivial.

T+12 to T+24 hours:
- Run one workflow_dispatch with full E2E matrix for current production commit.
- Compare production behavior to smoke screenshots for drift.

T+24 to T+48 hours:
- Publish defect trend snapshot (new/open/resolved by severity).
- Close or schedule all P0/P1 follow-ups.
- Decide whether to keep release lock or permit normal feature flow.

## Prescriptive CI Gate Changes

Goal:
- Keep deployments fast for hotfixes while preserving a deterministic production safety gate.

Required checks for merge to main:
- CI/CD Pipeline / build

Required checks for production-ready declaration:
- CI/CD Pipeline / build
- CI/CD Pipeline / deploy
- CI/CD Pipeline / deploy_frontend
- CI/CD Pipeline / deploy_backend_smoke
- CI/CD Pipeline / deploy_frontend_smoke

Non-blocking advisory checks (until stabilized):
- Full Playwright role matrix browser suite.
- Token refresh + browser persona matrix.

Workflow policy updates to apply:
1. Add workflow_dispatch input `run_full_e2e` default `false`.
2. Gate full E2E steps to run only when:
- tag push (`x.y.z`, for example `4.0.0`), or
- release event, or
- workflow_dispatch with `run_full_e2e == true`.
3. Keep deploy and postdeploy smoke jobs always enabled on main push.
4. Mark full E2E matrix as non-required branch protection check until flake rate is below 5% over 20 runs.

Stability SLOs:
- Required gate pass rate: >= 95% over last 20 runs.
- Any test with 2 flaky failures in 24h is removed from required gate and tracked in flaky queue until 10 consecutive green runs.
