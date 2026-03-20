# PHW Alpine Events - PRD v1.1 Full Compare (2026-03-20)

Source of truth compared: `PHW_Alpine_Events_PRD_1.md` (v1.1)

This report is a code-and-behavior comparison against the current implementation in this repository and latest production validation already completed in this session.

## 1) Current Baseline

- Branch/repo state: clean tracked files, synced with `origin/main`
- Latest reliability commit already pushed: `00c6976`
- Backend production health endpoints were previously validated as healthy (`/health`, `/health/startup`, `/health/ready`)

## 2) PRD Coverage Matrix

Legend:
- Complete: implemented and discoverable in code/UI
- Partial: present but not fully aligned to PRD wording/acceptance
- Open: not yet implemented

### 2.1 Member Management (Section 6.1, US-MM)

Status: **Mostly Complete**

Implemented evidence:
- CSV import preview/commit/logs and shared-email conflict workflow exists in UI and API stack.
- SMS consent update + audit log endpoints exist.
- Inbound `STOP` opt-out handling exists and writes consent log.
- Phone normalization support is wired in member/import services.

Gaps:
- PRD asks for broader channel preferences (email-only / SMS-only / both). Current self-service page is SMS toggle only.

### 2.2 Group Management (Section 6.2, US-MM-09)

Status: **Complete**

Implemented evidence:
- Admin group CRUD and membership management pages/routes are present.
- Per-group targeting behavior is represented in notification targeting and RSVP context.

### 2.3 Event Management + Notifications (Section 6.3, US-EM)

Status: **Partial**

Implemented evidence:
- Event CRUD/status transitions, publish/update/cancel flows exist.
- RSVP via authenticated web, tokenized public RSVP, and SMS Y/N/M/W parsing exist.
- SMS disambiguation for multiple pending events exists (`Y 1`, `N 1`, etc.).
- Reminder job and waitlist auto-promotion mechanics exist.
- Update/cancel notification dispatch flows exist.
- Notification runtime mode/strict readiness checks now exist in startup diagnostics and preflight guards.

Gaps vs PRD:
- **Waitlist offer window** PRD requires 48h; code default is 24h (`WAITLIST_OFFER_WINDOW_HOURS ?? '24'`).
- **Template management CRUD (admin)** required by PRD task list is not exposed as a dedicated route/page.
- **AI invite generation** is not implemented.
- **AI equity recommendations** for assignment are not implemented.
- **Email To-line regional admin addresses** is only partially aligned. Current ACS implementation sends `to: senderAddress`, `bcc: recipient`, not an explicit configurable regional admin list.

### 2.4 Take a Vet Fishing (Section 6.4, US-TV)

Status: **Mostly Complete**

Implemented evidence:
- Posting creation/list/detail/application/match flows are present.
- Expiry job exists (`tavfExpiryJob`).

Gap:
- Notification behaviors around TAVF are still partly stubbed in service comments/implementation path and should be hardened end-to-end for production confidence.

### 2.5 Calendar + Reporting (Section 6.5/6.6, US-CR)

Status: **Partial**

Implemented evidence:
- Calendar month/list with capacity badges exists.
- Reports summary/export/participation are implemented.

Gaps:
- **ICS download** for individual events not found.
- **Notification delivery report by channel** not found as a dedicated admin report endpoint/page.

### 2.6 Compliance / Legal / UX (Sections 4.3, 4.4, 10.x)

Status: **Partial**

Implemented evidence:
- SMS STOP/HELP flows and consent logging are implemented.
- Privacy/Terms/SMS program pages exist.
- Accessibility improvements were made in member modal UX.

Gaps:
- Full production proof of ACS/Event Grid inbound path and carrier compliance reporting should remain a recurring smoke check.
- Data retention automation windows described in PRD are not represented as explicit jobs in repo.

## 3) Next Tasks (Prioritized, PRD-Mapped)

## P0 - Must close for PRD alignment

1. **Align waitlist window to PRD 48h**  
   PRD refs: Section 6.7, US-EM-18, T-EVT-18  
   Implementation: change default waitlist offer window to 48h and add tests for expiry/offer rollover.

2. **Add notification delivery report (email/sms sent/delivered/failed)**  
   PRD refs: Section 6.6, US-CR-06, T-CAL-07  
   Implementation: add reports API + admin UI table/charts sourced from `notification_log`.

3. **Harden TAVF notification path from stubbed behavior to production-complete**  
   PRD refs: Section 6.4, US-TV-02/03/04, T-TAV-03  
   Implementation: replace placeholder/stub notification flows with strict runtime-checked dispatch and tests.

## P1 - Should Have

4. **Build notification template management (admin CRUD)**  
   PRD refs: US-EM-13, T-EVT-16  
   Implementation: template routes + admin page + validation for variables/length constraints.

5. **Add ICS event download**  
   PRD refs: US-CR-07, T-CAL-08  
   Implementation: backend `.ics` generator endpoint and calendar/detail UI button.

6. **Implement channel preference model beyond SMS toggle**  
   PRD refs: Section 10.4 (notification preferences)  
   Implementation: member-level channel mode (`email_only`, `sms_only`, `both`) and enforcement in dispatch layer.

7. **Regional admin To-line configuration for email dispatch**  
   PRD refs: Section 6.3.2, 13 (open question resolved by config)  
   Implementation: configurable admin-to list in app settings; keep recipients in BCC.

## P2 - Nice to Have / Phase 4

8. **AI invite generation**  
   PRD refs: US-EM-12, T-EVT-15

9. **AI participation equity recommendations in assignment UX**  
   PRD refs: US-EM-09, T-EVT-11

## 4) Suggested Execution Order (Smallest Risk First)

1. Waitlist 48h correction + tests
2. Notification delivery report (API then UI)
3. ICS endpoint + UI action
4. Template CRUD
5. Channel preference model extension
6. TAVF notification hardening
7. AI features

## 5) Acceptance Checks For Next Wave

- Waitlist promotion test proves 48h offer expiry behavior.
- Reports page includes delivery-status channel report and export.
- Event detail/calendar exposes working `.ics` download.
- Template CRUD can safely create, validate, and set default templates.
- Notification preferences enforce channel mode in all dispatch paths.
- TAVF creation/match/cancel trigger real notifications with logs.

## 6) Evidence Pointers (Key Files)

- Inbound SMS STOP/HELP/disambiguation: `backend/src/routes/sms.ts`
- Waitlist window default: `backend/src/services/rsvpService.ts`
- Notification runtime strict checks: `backend/src/services/notifications.ts`
- Health startup notification diagnostics: `backend/src/routes/health.ts`
- Public tokenized RSVP route/page: `backend/src/routes/publicRsvp.ts`, `frontend/src/pages/PublicRsvpPage.tsx`
- Calendar and capacity UI: `frontend/src/pages/CalendarPage.tsx`
- Reports summary/export/participation: `backend/src/routes/reports.ts`, `frontend/src/pages/ReportsPage.tsx`
- SMS preference UI: `frontend/src/pages/NotificationPreferencesPage.tsx`
- Group/member/import admin pages: `frontend/src/pages/GroupsPage.tsx`, `frontend/src/pages/MembersPage.tsx`, `frontend/src/pages/ImportPage.tsx`
