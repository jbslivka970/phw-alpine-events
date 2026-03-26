# PHW Alpine Events - Launch Readiness Work Plan and PRD Traceability

Date: 2026-03-20
Owner: Product + Engineering
Status: Active launch plan

## 1) Purpose

This document is the clean execution list from current state to full launch readiness. It is organized for sprint planning, PR review, and stakeholder check-ins.

Use this document as:
- Launch backlog (what to build next)
- PR-to-PRD traceability map (why each PR exists)
- Acceptance gate checklist (how we decide launch-ready)

## 2) Current Baseline

Completed and stable enough to build on:
- Member/group CRUD and CSV import workflows
- Event CRUD, publish/cancel, assignment, attendance
- Public/authenticated RSVP flows
- TAVF posting/application/match flows plus expiry job
- Calendar and reports pages, including delivery breakdown

Still required for full launch:
- Inbound SMS compliance path in production (Event Grid + inbound handler)
- Reminder automation and idempotency
- Functional email unsubscribe workflow
- Remaining PRD feature and operational gaps listed below

## 3) Launch Definition

Full launch readiness means all of the following are true:
1. Compliance-critical requirements are production validated (SMS STOP and email unsubscribe).
2. Notification operations are reliable (inbound path, reminders, logs, retries/alerts).
3. Core member experience is complete without forced login for RSVP links.
4. Admin operations have sufficient controls and visibility.
5. Regression tests and smoke checks run on every deploy.

## 4) Work Items to Launch

Legend:
- Priority: P0 launch blocker, P1 pre-GA hardening, P2 post-GA enhancement
- Stage: Build, Validate, Operate

| ID | Priority | Work Item | Stage | Status | PRD References | Proposed PR |
|---|---|---|---|---|---|---|
| LR-01 | P0 | Inbound SMS path: STOP/HELP/RSVP through ACS Event Grid into app | Build | In Progress | 4.3, 6.3.3, US-MM-08, US-EM-05, T-IF-05, T-MEM-10, T-EVT-07 | PR-33 |
| LR-02 | P0 | Production SMS compliance smoke suite and alerts | Validate | In Progress | 4.3, 11.x | PR-33a |
| LR-03 | P0 | Automated reminders with idempotent send markers | Build | In Progress | 6.3.4, US-EM-06, US-EM-07, T-EVT-09 | PR-34 |
| LR-04 | P0 | Tokenized one-click RSVP from email (no login required) | Build | In Progress | 6.3.3, US-EM-04, T-EVT-08 | PR-35 |
| LR-05 | P0 | Email unsubscribe link and enforcement workflow | Build | In Progress | 4.4 | PR-36 |
| LR-06 | P1 | Event update notifications with changed-field summary | Build | Not Started | 6.3.7, US-EM-16, T-EVT-14 | PR-37 |
| LR-07 | P1 | Waitlist auto-promotion lifecycle and expiry handling | Build | Not Started | 6.7, US-EM-18, T-EVT-18 | PR-38 |
| LR-08 | P1 | Notification template admin CRUD UI | Build | Not Started | 6.3.6, US-EM-13, T-EVT-16 | PR-41 |
| LR-09 | P1 | Regional admin To-line configuration for email dispatch | Build | Not Started | 6.3.2, 13 decision item | PR-43 |
| LR-10 | P1 | Channel preferences model: email_only, sms_only, both | Build | Not Started | 10.4, GAP-14 | PR-44 |
| LR-11 | P1 | Complete notification service unit tests (email/sms/truncation) | Validate | Not Started | 14.1 PR31 follow-up, GAP-13 | PR-32 |
| LR-12 | P1 | Application Insights wiring and alert baselines | Operate | Not Started | 4.1, 11.x, Open Question 17 | PR-45 |
| LR-13 | P1 | Key Vault migration plan for sensitive app settings | Operate | Not Started | 4.1, GAP-19 | PR-46 |
| LR-14 | P2 | ICS download from event detail and calendar context | Build | Not Started | 6.5, US-CR-07, T-CAL-08 | PR-42 |
| LR-15 | P2 | Delivery report UX polish (filters/export/trends) | Build | Not Started | 6.6, US-CR-06, T-CAL-07 | PR-42b |
| LR-16 | P2 | AI invite generation | Build | Not Started | 6.3.6, US-EM-12, T-EVT-15 | PR-39 |
| LR-17 | P2 | AI equity recommendations for assignment | Build | Not Started | 6.3.5, US-EM-09, T-EVT-11 | PR-40 |

## 5) Recommended Delivery Order

### Phase A - Launch Blockers (must close)
1. LR-01 inbound SMS path
2. LR-02 compliance smoke and alerts
3. LR-03 reminders
4. LR-04 tokenized RSVP from email
5. LR-05 email unsubscribe

### Phase B - Pre-GA Hardening
1. LR-11 unit test completion
2. LR-06 event update notifications
3. LR-07 waitlist lifecycle
4. LR-08 template admin UI
5. LR-09 regional admin To-line config
6. LR-10 channel preference model
7. LR-12 observability alerts
8. LR-13 secrets hardening plan

### Phase C - Post-GA Enhancements
1. LR-14 ICS download
2. LR-15 delivery UX polish
3. LR-16 AI invites
4. LR-17 AI equity recommendations

## 6) PR-to-PRD Review Template

Use this block in every PR description:

- PR ID: PR-XX
- Work Item ID: LR-XX
- PRD Sections: <section refs>
- PRD Tasks/User Stories: <IDs>
- Scope: <what this PR changes>
- Non-Goals: <what is explicitly deferred>
- Test Evidence:
  - Unit:
  - Integration:
  - Smoke:
- Rollback Plan:
- Launch Risk Change: increased / reduced / unchanged

## 7) Team Review Checklist

1. Does each P0 item have an assigned owner and target sprint?
2. Does each P0 item include production validation criteria?
3. Are compliance items represented with explicit pass/fail evidence?
4. Is every planned PR mapped to at least one PRD section?
5. Are post-launch items clearly separated from launch blockers?

## 8) Launch Gate Evidence (Required)

Before full launch sign-off, collect and attach:
1. Inbound STOP live proof with consent log entries
2. Inbound RSVP keyword and disambiguation proof
3. Reminder run proof with no duplicate sends
4. Tokenized email RSVP flow proof for shared-email household scenario
5. Unsubscribe path proof with suppression enforcement
6. Notification log report screenshots for sent/failed/skipped by channel
7. UAT sign-off from admin and event-creator personas

## 9) Notes

- Proposed PR numbering follows the existing roadmap sequence for continuity.
- If scope is split, use suffixes (example: PR-33a, PR-42b) while keeping LR IDs stable.
- If priorities change, update only this document first, then mirror in PRD team review section.

## 10) Execution Log

2026-03-25
- Started LR-02 with a new inbound SMS compliance smoke harness.
- Added script: `scripts/sms-compliance-smoke.js`.
- Added runbook: `docs/sms-compliance-smoke-runbook.md`.
- Added command: `npm --prefix backend run smoke:sms`.
- Contract mode validated against deployed backend endpoint with PASS result.
- Added LR-01 hardening step: inbound SMS audit persistence in `inbound_sms_log` from `POST /api/v1/sms/inbound` processing paths.
- Added admin retrieval endpoint: `GET /api/v1/sms/inbound/logs` (admin-only) for operational verification.
- Started LR-03 reminder reliability hardening.
- Updated reminder job to isolate per-channel failures (email/sms) and continue processing subsequent rows.
- Added completion metrics log event (`reminder_job_completed`) with attempted/delivered/failed counters.
- Added tests covering email-failure SMS fallback and row-level continuation behavior.
- Commit: `f53dcc9` pushed to `main` for LR-03 reliability slice.
- CI/CD run `23562201012` completed with `success`.
- Post-deploy checks: backend root/health/ready all `200`; frontend root `200`.
- Post-deploy SMS contract smoke: `result=PASS`.
- Started LR-04 by fixing frontend tokenized RSVP API wiring.
- Updated `emailRsvpApi` to call `/api/v1/events/rsvp/:token` (GET and POST) instead of `/api/v1/sms/inbound`.
- Frontend production build completed successfully after the routing fix.
- Started LR-05 email unsubscribe implementation with signed-link flow.
- Added public unsubscribe endpoints: `GET/POST /api/v1/preferences/email/unsubscribe/:token`.
- Added auditable log retrieval endpoint: `GET /api/v1/preferences/email/logs` (admin-only).
- Added signed token + link builder service for email unsubscribe links.
- Added automatic unsubscribe footer injection for outbound emails with member context.
- Added schema migration for `email_preference_log` audit table and indexes.
- Added route tests in `backend/src/__tests__/preferences.test.ts` and validated full backend test suite + build.
- Commit: `7bce3d2` pushed to `main` for LR-05 signed unsubscribe workflow.
- CI/CD run `23607402104` completed with `success`.
- Post-deploy checks: backend root/health/ready all `200`; frontend root `200`.
- Post-deploy SMS contract smoke: `result=PASS`.
- Production sanity check: `GET /api/v1/preferences/email/unsubscribe/not-a-real-token` returned `400` with expected invalid-token HTML response.
- Added LR-05 validation assets: `scripts/email-unsubscribe-smoke.js` and `docs/email-unsubscribe-smoke-runbook.md`.
- Added command: `npm --prefix backend run smoke:email`.
- Added LR-04 validation assets: `scripts/tokenized-rsvp-smoke.js` and `docs/tokenized-rsvp-smoke-runbook.md`.
- Added command: `npm --prefix backend run smoke:rsvp`.
- Commit: `3d2d0a4` pushed to `main` for LR-04 RSVP smoke harness.
- CI/CD run `23608650646` completed with `success`.
- Post-deploy checks: backend root/health/ready all `200`; frontend root `200`.
- Post-deploy smoke checks: `smoke:sms` PASS, `smoke:email` PASS, and `smoke:rsvp` PASS.
- Added deployment gate command: `npm --prefix backend run smoke:all` (sms + email + rsvp contract checks).
- Updated CI/CD workflow to run post-deploy compliance smokes on every `main` deployment.
- Added LR-03 evidence assets: `GET /api/v1/reports/reminders`, `scripts/reminder-duplication-smoke.js`, and `docs/reminder-duplication-smoke-runbook.md`.
- Added reminder operation tagging (`operation_type=event_reminder`) for reportability.
- Added command: `npm --prefix backend run smoke:reminders` (admin-token optional/required for report access).
- Commit: `87110db` pushed to `main` for LR-05 email smoke harness.
- CI/CD run `23608085443` completed with `success`.
- Post-deploy checks: backend root/health/ready all `200`; frontend root `200`.
- Post-deploy smoke checks: `smoke:sms` PASS and `smoke:email` PASS.
- Commit: `d921990` pushed to `main` for LR-04 endpoint wiring fix.
- CI/CD run `23562680904` completed with `success`.
- Post-deploy checks: backend root/health/ready all `200`; frontend root `200`.
- Post-deploy SMS contract smoke: `result=PASS`.
