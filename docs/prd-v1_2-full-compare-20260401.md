# PHW Alpine Events - PRD v1.2 Full Compare (2026-04-01)

Source of truth compared: `PHW_Alpine_Events_PRD_v1.2.md`.

This report compares the current repository implementation with PRD v1.2 and identifies only the remaining steps to completion.

## 1) Executive Delta

PRD v1.2 is directionally correct, but several status rows in Sections 9, 14, and 15 are now outdated relative to current code.

Most notable deltas:
- Inbound SMS parsing and STOP/HELP processing are implemented in API routes and tests.
- Reminder and waitlist lifecycle jobs are implemented and scheduled in backend runtime.
- Tokenized RSVP links and email unsubscribe flows are implemented.
- Template admin CRUD plus version history and rollback are implemented.
- ICS download and delivery report APIs/UI are implemented.
- AI invite draft generation and assignment equity recommendations are implemented (with fallback mode when OpenAI is not configured).

## 2) PRD v1.2 Gap Reconciliation

### 2.1 PRD Section 15 Critical Gaps

1. GAP-01 Inbound SMS RSVP parsing: **Implemented**
- Evidence: `backend/src/routes/sms.ts` (`POST /api/sms/inbound`, Y/N/M/W parsing, disambiguation).
- Evidence: `backend/src/__tests__/sms.test.ts` (direct + Event Grid-shaped payload tests).

2. GAP-02 Inbound STOP processing: **Implemented**
- Evidence: `backend/src/routes/sms.ts` (`STOP` handling + member opt-out + consent log).
- Evidence: `backend/src/__tests__/sms.test.ts` STOP flow test.

3. GAP-03 Automated reminders: **Implemented**
- Evidence: `backend/src/jobs/reminderJob.ts`.
- Evidence: `backend/src/index.ts` scheduler wiring (`REMINDER_JOB_INTERVAL_MS`).
- Evidence: `backend/src/__tests__/reminderJob.test.ts`.

4. GAP-04 Email unsubscribe mechanism: **Implemented**
- Evidence: `backend/src/routes/preferences.ts` (`/preferences/email/unsubscribe/:token`).
- Evidence: `backend/src/services/emailPreferenceLinkService.ts`.
- Evidence: `backend/src/__tests__/preferences.test.ts`.

5. GAP-05 Tokenized email RSVP: **Implemented**
- Evidence: `backend/src/services/rsvpLinkService.ts` (signed token generation/verification).
- Evidence: `backend/src/routes/sms.ts` tokenized RSVP path.
- Evidence: `frontend/src/pages/PublicRsvpPage.tsx`.

6. GAP-06 Template admin UI: **Implemented**
- Evidence: `frontend/src/pages/TemplatesPage.tsx` (CRUD + history + rollback).
- Evidence: `backend/src/routes/templates.ts` + `backend/src/__tests__/templates.test.ts`.

### 2.2 PRD Section 15 Important Gaps

7. GAP-07 AI participation equity analysis: **Implemented**
- Evidence: `frontend/src/pages/EventAssignmentPage.tsx` (recommendation display).
- Evidence: backend recommendation endpoints/services in current API stack.

8. GAP-08 AI invite copy generator: **Implemented**
- Evidence: `backend/src/routes/admin.ts` (`/admin/ai/invite-draft`, `/admin/ai/invite-draft/apply`).
- Evidence: `backend/src/services/aiInviteService.ts`.
- Evidence: `frontend/src/pages/AdminPage.tsx`.

9. GAP-09 Event update notification: **Implemented**
- Evidence: `backend/src/routes/events.ts` update flow calls `sendEventUpdatedNotification(...)` for published events.
- Evidence: `backend/src/services/notifications.ts` update template/render support.

10. GAP-10 Waitlist auto-promotion: **Implemented**
- Evidence: `backend/src/jobs/waitlistLifecycleJob.ts`.
- Evidence: `backend/src/services/rsvpService.ts` waitlist promotion logic.
- Evidence: scheduler wiring in `backend/src/index.ts`.

11. GAP-11 ICS download: **Implemented**
- Evidence: `backend/src/routes/events.ts` (`GET /events/:id/ics`).
- Evidence: `frontend/src/pages/EventsPage.tsx`, `frontend/src/pages/CalendarPage.tsx`.
- Evidence: `backend/src/__tests__/events.test.ts` ICS test.

12. GAP-12 Notification delivery report UI: **Implemented**
- Evidence: `backend/src/routes/reports.ts` (`/reports/delivery`, `/reports/delivery/trends`).
- Evidence: `frontend/src/pages/ReportsPage.tsx` (filters, table, trend chart).

13. GAP-13 Notification service unit test completion: **Partially complete**
- Route-level and job-level coverage are strong, but dedicated service-class unit tests for all notification service branches remain a quality-hardening opportunity.

### 2.3 PRD Section 15 Nice-to-Have

14. GAP-14 Channel preferences (email_only/sms_only/both): **Implemented**
- Evidence: `frontend/src/pages/NotificationPreferencesPage.tsx`, `frontend/src/pages/MembersPage.tsx`.

15. GAP-15 Post-event thank-you notifications: **Not implemented**
16. GAP-16 Event photo attachments: **Not implemented**
17. GAP-17 First-time onboarding flow from unauth context: **Not implemented**
18. GAP-18 App Insights + alerting confirmation: **Operational status to verify**
19. GAP-19 Key Vault migration: **Not implemented (current env-var model in use)**

## 3) Current Completion Status vs PRD v1.2

### 3.1 Product Capability Completion

- Core member/group/event/TAVF/calendar/reporting domains: **Complete**.
- Notification platform (email, SMS, inbound processing, reminders, unsubscribe, templates): **Complete** at product level.
- AI assist features (invite + equity): **Complete** with graceful fallback behavior if OpenAI is not configured.

### 3.2 Remaining to Completion

Remaining work is now mostly operational and governance, not core feature delivery.

## 4) Remaining Steps to Completion (Action Map)

## P0 - Operational Sign-off (must close)

1. Production retention policy rollout
- Finalize table-specific retention windows.
- Run `/api/v1/admin/retention/preview` evidence for each target.
- Approve delete-mode cutover and enable `RETENTION_CONFIRM_DELETE=true` intentionally.

2. Production compliance evidence cadence
- Run scheduled smoke checks for inbound STOP/HELP/RSVP behavior and archive output.
- Confirm toll-free carrier verification state and document it in ops runbook.

3. Template governance execution
- Enforce review cadence using `docs/template-governance-policy.md`.
- Record periodic rollback/audit evidence in release notes.

## P1 - Quality and reliability hardening

4. Notification service unit-test depth
- Add focused tests for service-level edge branches (transport failures, fallback behavior, metadata writes).

5. Frontend performance pass
- Reduce bundle size via code splitting/manual chunks.
- Re-run frontend regression flows and browser E2E checks.

6. CI runtime modernization
- Update workflow action/toolchain targets impacted by Node 20 deprecation warnings.

## P2 - Nice-to-have polish

7. Post-event thank-you notifications.
8. Event photo attachments.
9. Optional first-time onboarding flow for unauthenticated invite/SMS users.
10. Key Vault migration and App Insights alert policy tightening.

## 5) Recommended Execution Sequence

1. Retention approval package and production cutover plan.
2. Compliance smoke scheduling + archived evidence workflow.
3. Notification service test hardening.
4. CI Node/runtime modernization.
5. Frontend performance tuning.
6. Optional polish items (P2).

## 6) Tracking Recommendation

Use this file as the v1.2 source-of-truth compare moving forward.
The previous v1.1 compare can remain for historical traceability.
