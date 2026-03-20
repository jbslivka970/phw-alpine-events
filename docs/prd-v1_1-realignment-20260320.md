# PRD v1.1 Realignment Snapshot (2026-03-20)

Superseded by the fuller gap analysis in `docs/prd-v1_1-full-compare-20260320.md`.

Source baseline: PHW_Alpine_Events_PRD_1.md (v1.1)

## 1) Deployment and Build Status

- Backend build: passed (local)
- Backend tests: passed (59/59)
- Frontend build: passed
- Backend production deploy: succeeded at 2026-03-20T17:08Z
- Backend runtime verification: health endpoints returning 200, startup payload includes notification runtime fields

Production verification sample:
- GET /api/v1/health/startup now includes:
  - checks.notificationMode
  - checks.notificationStrictModeEnabled
  - checks.emailNotificationChannel
  - checks.smsNotificationChannel
  - missing.notifications

## 2) PR / Commit Alignment to Major PRD Areas

## 2.1 Wave PR coverage (historical)

- PR22: ACS configuration wiring
- PR23: ACS SMS + skipped status behavior
- PR24: Email templates and publish/cancel dispatch
- PR25: Calendar backend wiring
- PR26: Reports summary/participation/export
- PR27: SMS consent endpoints + audit UI
- PR28: Event assignment and attendance
- PR29: Dashboard event/member stats wiring
- PR30: TAVF completion + expiry path
- PR31: test stabilization and follow-through fixes

## 2.2 Post-wave production fixes already completed

- Import auth bugfix: [frontend/src/api/client.ts](frontend/src/api/client.ts), [frontend/src/api/imports.ts](frontend/src/api/imports.ts)
  - Commit: 4bc1e7e
- Import log download clarity + member edit modal UX:
  - [frontend/src/pages/ImportPage.tsx](frontend/src/pages/ImportPage.tsx)
  - [frontend/src/pages/MembersPage.tsx](frontend/src/pages/MembersPage.tsx)
  - [frontend/src/index.css](frontend/src/index.css)
  - Commit: 9c46be1
- Modal accessibility polish (Esc close, focus trap, scroll lock):
  - [frontend/src/pages/MembersPage.tsx](frontend/src/pages/MembersPage.tsx)
  - Commit: 54929c7
- Event update/cancel and waitlist improvements from previous wave continuation:
  - Commit: 4dd4611
  - Commit: 5e8f4d3

## 2.3 New reliability hardening completed in this pass

- Notification mode introspection and strict-mode fail-fast logic:
  - [backend/src/services/notifications.ts](backend/src/services/notifications.ts)
- Event publish/update/cancel preflight checks and explicit 503 config responses:
  - [backend/src/routes/events.ts](backend/src/routes/events.ts)
- Startup diagnostics expanded for channel/mode visibility:
  - [backend/src/routes/health.ts](backend/src/routes/health.ts)
- Test updates for route mock compatibility:
  - [backend/src/__tests__/events.test.ts](backend/src/__tests__/events.test.ts)

Note: These latest backend changes were subsequently committed and pushed as commit `00c6976`.

## 3) PRD Feature Status (Top-Level)

Legend: Complete = implemented and validated. Partial = implemented but with notable constraints. Open = still to build.

## 3.1 Core event and member operations

- Member CRUD, grouping, import pipeline: Complete
- CSV preview/commit/log/report flow: Complete
- Shared-email matching behavior in import: Partial/validated in pipeline, continue edge-case UAT
- Event CRUD + status transitions: Complete
- Group-targeted dispatch model: Complete
- RSVP via authenticated web: Complete
- Dashboard + calendar + reports baseline: Complete

## 3.2 Notifications and compliance-critical behavior

- Real ACS email/SMS channel support: Complete
- SMS opt-in preferences and audit surfaces: Complete
- Strict channel readiness transparency at startup: Complete
- Strict fail-fast switch for notification channel gaps: Complete (env-controlled)
- Inbound STOP via carrier webhook path: Partial/Open depending on deployment topology verification
- Full inbound SMS RSVP disambiguation flow in production: Partial/Open depending on inbound event-grid route and endpoint wiring validation

## 3.3 UX and usability

- Member edit discoverability: Complete (modal)
- Modal accessibility keyboard behavior: Complete
- Import report download discoverability: Complete
- Admin/operator visibility into notification readiness: Improved (startup diagnostics), still no dedicated frontend admin status panel

## 3.4 AI and advanced PRD capabilities

- AI invite generation: Open
- AI participation equity recommendations: Open

## 4) Highest-Value Remaining Work

## P0 / risk-first

1. End-to-end inbound SMS compliance path hardening
- Verify carrier inbound -> ACS/Event Grid -> app handler in production with true STOP and Y/N/M/W flows.
- Add explicit smoke tests and operator dashboard signal when inbound pipeline is broken.

2. Tokenized no-auth RSVP coverage and resilience hardening
- Keep expanding link lifecycle tests (expiry, replay, invalid token, wrong event/member).

3. Notification operations panel
- Add admin UI panel for runtime mode and channel readiness so non-technical operators do not depend on health JSON.

## P1

4. Event update notification UX polish
- Improve changed-field rendering in UI and template management.

5. Waitlist flow end-to-end UAT pack
- Validate timing window, retries, and fallback behavior with production-like data volumes.

## P2

6. AI invite generation
7. AI participation equity recommendations

## 5) Focused Testing Recommendations

## 5.1 Must-run smoke after each backend deploy

1. Health
- /api/v1/health == 200
- /api/v1/health/startup == 200 and includes notification mode/channel fields
- /api/v1/health/ready == 200

2. Event lifecycle
- Draft -> publish with valid channels
- Published edit with changed fields
- Published -> cancelled
- Confirm expected notification logs written per action

3. Import path
- Preview upload auth
- Commit import with mixed valid/invalid rows
- Download import report from history

4. Member operations
- Open member edit modal, keyboard nav, save, close, focus restore

## 5.2 Compliance / operational

5. STOP handling live test with test number
6. SMS keyword disambiguation with multiple active events
7. Verify no SMS sent to opted-out member paths

## 6) UI Improvements Already Landed (for stakeholder demo)

- Import History wording now clearly indicates downloadable reports.
- Member edit is modal-first (more discoverable than long-page inline edit).
- Modal keyboard behavior now meets expected accessibility baseline:
  - Esc close
  - Focus trap
  - Scroll lock while open

## 7) Repository Alignment

- Reliability hardening changes were committed and pushed as `00c6976`.
- Use `docs/prd-v1_1-full-compare-20260320.md` as the active plan document for remaining PRD work.
