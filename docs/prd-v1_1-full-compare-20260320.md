# PHW Alpine Events - PRD v1.1 Full Compare (2026-03-20)

Source of truth compared: `PHW_Alpine_Events_PRD_1.md` (v1.1)

This report is a code-and-behavior comparison against the current implementation in this repository and latest production validation already completed in this session.

## 1) Current Baseline

- Mainline has been consolidated and version-tagged through `v1.2.2`.
- Backend production health endpoints were previously validated as healthy (`/health`, `/health/startup`, `/health/ready`).
- Core PRD feature domains are implemented; remaining gaps are primarily operational governance and recurring production verification evidence.

## 2) PRD Coverage Matrix

Legend:
- Complete: implemented and discoverable in code/UI
- Partial: present but not fully aligned to PRD wording/acceptance
- Open: not yet implemented

### 2.1 Member Management (Section 6.1, US-MM)

Status: **Complete (with UX depth follow-up)**

Implemented evidence:
- CSV import preview/commit/logs and shared-email conflict workflow exists in UI and API stack.
- SMS consent update + audit log endpoints exist.
- Inbound `STOP` opt-out handling exists and writes consent log.
- Phone normalization support is wired in member/import services.

Gaps:
- Channel preferences (`email_only`, `sms_only`, `both`) now exist for admin and self-service flows; remaining improvement is richer preference explanations and onboarding copy.

### 2.2 Group Management (Section 6.2, US-MM-09)

Status: **Complete**

Implemented evidence:
- Admin group CRUD and membership management pages/routes are present.
- Per-group targeting behavior is represented in notification targeting and RSVP context.

### 2.3 Event Management + Notifications (Section 6.3, US-EM)

Status: **Complete (with governance and production-evidence follow-up)**

Implemented evidence:
- Event CRUD/status transitions, publish/update/cancel flows exist.
- RSVP via authenticated web, tokenized public RSVP, and SMS Y/N/M/W parsing exist.
- SMS disambiguation for multiple pending events exists (`Y 1`, `N 1`, etc.).
- Reminder job and waitlist auto-promotion mechanics exist.
- Update/cancel notification dispatch flows exist.
- Notification runtime mode/strict readiness checks now exist in startup diagnostics and preflight guards.
- Template management now includes CRUD plus version history/rollback support.
- AI invite draft generation is implemented (OpenAI-backed with deterministic fallback) and can be applied to active templates with admin review confirmation.
- Assignment equity recommendations endpoint/UI is implemented.
- Regional email To-line config exists via `ACS_EMAIL_TO`.

Gaps vs PRD:
- Remaining gap is operational governance depth (for example, formal approval policy execution and periodic audit review evidence), not core product capability.

### 2.4 Take a Vet Fishing (Section 6.4, US-TV)

Status: **Complete (with operational verification follow-up)**

Implemented evidence:
- Posting creation/list/detail/application/match flows are present.
- Expiry job exists (`tavfExpiryJob`).

Gap:
- Notification functions for posting/application/match/cancel are implemented in the notification service and invoked from TAVF service flows; remaining work is production smoke coverage and service-level notification test depth.

### 2.5 Calendar + Reporting (Section 6.5/6.6, US-CR)

Status: **Complete (with UX polish follow-up)**

Implemented evidence:
- Calendar month/list with capacity badges exists.
- Reports summary/export/participation are implemented.
- ICS download endpoint and calendar UI action are implemented.

Gaps:
- Notification delivery report endpoint and UI table exist; optional export/chart polish can be scheduled as UX enhancement.

### 2.6 Compliance / Legal / UX (Sections 4.3, 4.4, 10.x)

Status: **Partial**

Implemented evidence:
- SMS STOP/HELP flows and consent logging are implemented.
- Privacy/Terms/SMS program pages exist.
- Accessibility improvements were made in member modal UX.

Gaps:
- Full production proof of ACS/Event Grid inbound path and carrier compliance reporting should remain a recurring smoke check.
- Data retention now includes scheduled job controls plus admin dry-run preview evidence (`/admin/retention/preview`); production policy values and governance sign-off execution remain to be finalized.

## 3) Next Tasks (Prioritized, PRD-Mapped)

## P0 - Must close for operational sign-off

1. **Production retention policy finalization + rollout**  
   PRD refs: Section 11.x / governance controls  
   Implementation: set retention windows per table/env, validate dry-run results, then enable delete mode in production with documented approvals.

2. **Operationalize template governance cadence**  
   PRD refs: US-EM-12, T-EVT-15, US-EM-13, T-EVT-16  
   Implementation: run the documented approval and periodic audit process in production and capture evidence.

3. **Recurring inbound compliance smoke evidence**  
   PRD refs: Sections 4.3, 4.4, 10.x  
   Implementation: execute scheduled production STOP/HELP/RSVP smoke checks and archive results.

## P1 - Should Have (quality and operations hardening)

4. **Notification reporting UX polish**  
   PRD refs: Section 6.6  
   Implementation: optional report export/chart views for delivery trends.

5. **Chunk-size reduction and frontend performance tuning**  
   PRD refs: NFR usability/performance intent  
   Implementation: code-split large bundles and verify unchanged behavior.

## 4) Suggested Execution Order (Smallest Risk First)

1. Retention dry-run evidence review and production window approval
2. Retention delete-mode production rollout with safeguards
3. Template governance approval/audit evidence checkpoint
4. Scheduled inbound SMS compliance smoke with archived proof
5. Optional reporting and frontend performance polish

## 5) Acceptance Checks For Next Wave

- Retention preview output is reviewed and approved for each target table before delete mode enablement.
- Retention delete mode runs with confirmation guard and per-target delete caps in production.
- Template change reviews and rollback audits are performed on cadence and recorded.
- Inbound SMS STOP/HELP/RSVP path works through deployed Event Grid path in production on recurring smoke checks.
- Existing functional coverage remains green (backend tests, frontend tests, and CI deployment pipeline).

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

## 7) Product Addendum (2026-04-07)

This addendum appends three tracked feature threads requested for the next delivery wave.

### 7.1 Auth and Identity Expansion (Admin Invite + Social Sign-In)

Goal:
- Support Microsoft and Google sign-in paths for members.
- Allow admins to invite members into Entra External ID directly from member workflows.
- Persist identity lifecycle status per member (Pending, Invited, Linked, Disabled).

Requirements:
- Member-facing sign-in supports approved providers configured in External ID user flow.
- Admin can send single-member and bulk-member identity invitations.
- Members page shows identity status and supports relink action for remediation.
- First successful sign-in links identity record to the member profile and enables standard USER access.

Acceptance criteria:
- Invite action returns success and stores invited timestamp for selected member(s).
- Identity status transitions from Pending -> Invited -> Linked after first successful auth.
- Google provider can be enabled without backend code changes once tenant/provider credentials are configured.
- Admin can re-run invite/relink safely for recoverable identity mismatches.

### 7.2 Event Atomic Operations and Record Accessibility

Goal:
- Make any visible event directly actionable for admins and event creators from all reasonable entry points.
- Improve post-event record extraction and archival sharing.

Requirements:
- From event views (calendar cards, event list/cards, event detail, and related admin views), authorized users can:
   - open the event,
   - edit event details,
   - update event state,
   - manually add/remove attendees and waitlist participants.
- Completed events can be exported in human-readable formats:
   - CSV/XLS-compatible export,
   - PDF-style summary artifact.
- Authorized users can send the single-event record to assistant program leads via email for archive/compliance.

Acceptance criteria:
- Event edit and participant-manual-management actions are reachable from all supported event surfaces.
- Export output includes event metadata, participant list, roles, statuses, and timestamps.
- Email-send action supports one-click event record delivery to configured leadership recipients.
- Audit trail logs who exported or emailed event records and when.

### 7.3 AI-Assisted Event Messaging (Creator Workflow)

Goal:
- Give event creators a stronger AI drafting workflow directly in event context.

Requirements:
- From event screen, creator can generate a draft outbound message with tone guidance:
   - professional,
   - warm/friendly,
   - always respectful and inclusive of military veteran audience context.
- AI draft should use event context (title, date/time, location, audience intent).
- System should support optional enrichment package:
   - mini map or map link snippet based on event location,
   - suggested outdoor/fly-fishing imagery references from public sources,
   - creator review/approve before publish.

Acceptance criteria:
- Creator can generate, edit, and apply AI draft from event workflow without leaving event context.
- Draft payload includes event-specific details and audience-aware phrasing.
- Location enrichment can be inserted as map link/snippet when location is valid.
- Image suggestions are reviewable and removable before send.
- Final outbound message remains subject to existing template approval and notification safeguards.

### 7.4 Priority and Sequencing Recommendation

1. Finish Auth and Identity Expansion production hardening and Google provider activation.
2. Deliver Event Atomic Operations and export/email record workflow.
3. Extend AI-Assisted Event Messaging with location and imagery enrichment after event atomic controls are stable.

