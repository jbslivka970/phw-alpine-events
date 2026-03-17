# Wave 2 — Cloud Agent PR Prompts

Sequential prompts for GitHub Copilot coding agents. Merge each PR before starting the next.

---

## Global Context (include with every agent prompt)

Each cloud agent should know the following about the codebase:

```
CODEBASE FACTS — read this before writing any code:

Project structure:
  backend/     — Node.js + Express + TypeScript (Azure SQL via mssql v9)
  frontend/    — React 18 + Vite + TypeScript
  database/    — schema.sql (Azure SQL, idempotent IF NOT EXISTS guards)

Build commands:
  Backend:  cd backend && npm run build   (runs tsc)
  Frontend: cd frontend && npm run build  (runs vite build)
  Tests:    cd backend && npm test        (runs jest with ts-jest preset)

Key backend patterns:
  - Database: import { getPool, sql } from '../db';  (mssql ConnectionPool)
  - Auth middleware: import authenticate from '../middleware/auth';  (DEFAULT export)
  - RBAC middleware: import { requireAdmin, requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';  (NAMED exports)
  - Rate limiting: import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
  - Config: import { loadServerConfig, loadDbConfig, loadAuthConfig } from '../config';
    Uses requireEnv(name) for mandatory vars, optionalEnv(name, fallback?) for optional.
  - Routes registered in backend/src/routes/index.ts via router.use('/path', someRouter)
  - Express Request.user is typed as: { sub: string; email?: string; name?: string; roles: AppRole[]; rawClaims: JwtPayload }
  - AppRole = 'ADMIN' | 'EVENT_CREATOR' | 'USER'

Key frontend patterns:
  - API client: import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client';
  - API base URL: VITE_API_BASE_URL env var, defaults to '/api/v1'
  - Auth hook: import { useAuth } from '../hooks/useAuth'  → { user, hasRole, isAdmin, login, logout }
  - Routing: react-router-dom v6, routes in App.tsx, wrapped by ProtectedRoute
  - ROLES constant: import { ROLES } from '../authConfig'

Schema column names (common gotcha):
  - Events use "event_date" (NOT "start_date") in the database
  - The frontend CalendarPage.tsx and ReportsPage.tsx currently use "start_date"
    in their TypeScript interfaces — this MUST be changed to "event_date" when
    wiring to real data

Tables that exist in schema.sql:
  member, [group], member_group, event, event_notification_target,
  event_response, event_assignment, notification_template, notification_log,
  sms_consent_log, import_log, [user], take_a_vet_posting,
  tavf_posting, tavf_application, tavf_match

notification_log.status CHECK constraint allows:
  'queued', 'sent', 'delivered', 'failed', 'stubbed'
  (if you need 'skipped', ALTER the constraint first)

event_assignment table columns:
  assignment_id, event_id, member_id, role, assigned_at, notes
  (NO 'attended' column exists yet — must be added if needed)
```

---

## Manual Prerequisite: Provision Azure Communication Services

Before PRs 22–24 can send real notifications, you need to provision ACS in Azure Portal. **Do this first — the code PRs can merge immediately; real sending activates once the env vars are set.**

### Step-by-step

1. **Create ACS resource**
   - Azure Portal → Create a resource → "Communication Services"
   - Name: `phw-alpine-acs` (or similar)
   - Resource group: same as your App Service
   - Region: United States
   - Click Review + Create → Create

2. **Get the connection string**
   - Open the ACS resource → Keys → copy `Connection string` (Primary)
   - This becomes your `ACS_CONNECTION_STRING` env var

3. **Set up Email**
   - In the ACS resource → Email → Try Email (or go to "Email Communication Services" in portal)
   - Create an Email Communication Service resource
   - Option A (quick): Use the **Azure-managed domain** (`xxxxxxxx.azurecomm.net`) — works immediately
   - Option B (production): Add your own custom domain, configure SPF/DKIM/DMARC records
   - Link the Email domain to your ACS resource: ACS → Email → Domains → Connect domain
   - The verified sender address becomes your `ACS_EMAIL_FROM` env var (e.g. `DoNotReply@xxxxxxxx.azurecomm.net`)

4. **Set up SMS (toll-free number)**
   - ACS resource → Phone numbers → Get a number
   - Select: Toll-free, United States, SMS (Send + Receive)
   - Purchase the number
   - **Important:** Submit toll-free verification (ACS → Phone numbers → Toll-free verification)
     - This takes **8–12 weeks** for carrier approval
     - Until verified, SMS sending may be rate-limited or blocked for A2P
   - The number in E.164 format becomes `ACS_SMS_FROM` (e.g. `+18005551234`)

5. **Set environment variables on App Service**
   - Azure Portal → App Service → Configuration → Application settings → Add:
     ```
     ACS_CONNECTION_STRING = endpoint=https://phw-alpine-acs.....
     ACS_EMAIL_FROM        = DoNotReply@xxxxxxxx.azurecomm.net
     ACS_SMS_FROM          = +18005551234
     ```
   - Save and restart the App Service

6. **(Later, for inbound SMS — PR 27)** Set up Event Grid
   - ACS resource → Events → + Event Subscription
   - Event type: `SMS Received`
   - Endpoint type: Azure Function (once deployed)

---

## PR 22 — Wire ACS Email Service

```
Title: feat: Wire Azure Communication Services email sending

Replace the StubEmailService in backend/src/services/notifications.ts with a real
AcsEmailService that sends email via @azure/communication-email (already installed
in package.json).

Requirements:
1. Add a new function loadAcsConfig() to backend/src/config.ts that reads:
   - ACS_CONNECTION_STRING (optional — return { isConfigured: false } if missing)
   - ACS_EMAIL_FROM (required when ACS is configured)
   - ACS_SMS_FROM (optional, for later use)

2. In backend/src/services/notifications.ts:
   - Add a new class AcsEmailService implementing the existing IEmailService interface
   - Constructor takes connectionString and senderAddress
   - sendEmail() uses EmailClient from @azure/communication-email:
     - Call client.beginSend() with senderAddress, to (recipients), subject, html body
     - Await the poller result (up to 60s timeout)
     - Throw on failure so the NotificationService logs the error
   - BCC support: the "to" field should use the ACS_EMAIL_FROM as the To address,
     and the actual recipient goes in the BCC field (per PRD Section 6.3.2)
   - Keep StubEmailService as fallback when ACS_CONNECTION_STRING is not set

3. Update the notificationService singleton at the bottom of notifications.ts:
   - If loadAcsConfig().isConfigured → use AcsEmailService
   - Otherwise → use StubEmailService (with a console.warn on startup)

4. Update the NotificationService class:
   - When AcsEmailService succeeds, set status to 'sent' (not 'stubbed')
   - Store the ACS message ID from the poller result as provider_id in notification_log

5. The writeNotificationLog() private method already accepts a `provider_id` param
   (currently hardcoded to null). Update it to plumb through the ACS messageId.

6. Do NOT change any route files or frontend files.
7. Backend must pass `npm run build` (tsc) with zero errors.

IMPORTANT implementation detail:
  - The existing NotificationService.sendEmail() always sets `status = 'stubbed'`.
    When using AcsEmailService, change it to set `status = 'sent'` on success.
  - The IEmailService interface is: { sendEmail(options: SendEmailOptions): Promise<void> }
    where SendEmailOptions = { to, subject, htmlBody, textBody?, templateId?, memberId?, eventId? }
  - The notificationService singleton is created at module scope at the bottom of notifications.ts.
    Replace `new StubEmailService()` with `new AcsEmailService(...)` conditionally.
```

---

## PR 23 — Wire ACS SMS Service

```
Title: feat: Wire Azure Communication Services SMS sending

Replace the StubSmsService in backend/src/services/notifications.ts with a real
AcsSmsService that sends SMS via @azure/communication-sms (already installed).

Requirements:
1. In backend/src/services/notifications.ts:
   - Add a new class AcsSmsService implementing the existing ISmsService interface
   - Constructor takes connectionString and fromNumber (E.164)
   - sendSms() uses SmsClient from @azure/communication-sms:
     - Call client.send({ from: fromNumber, to: [options.to], message: options.message })
     - Check the result for success; throw if any recipient failed
   - Keep StubSmsService as fallback when ACS is not configured

2. Update the notificationService singleton:
   - If loadAcsConfig().isConfigured AND loadAcsConfig().smsFrom is set → use AcsSmsService
   - Otherwise → use StubSmsService

3. Update NotificationService.sendSms():
   - On success from real service, set status to 'sent'
   - Store messageId as provider_id in notification_log

4. Enforce the 160-character SMS limit:
   - If the message exceeds 160 chars, truncate to 157 + "..." and log a warning
   - Add a helper function truncateSms(message: string, limit?: number): string

5. Check sms_opt_in before sending:
   - Add a guard: before dispatching SMS, query the member table for sms_opt_in.
     If sms_opt_in is false/null, skip and log status='skipped' in notification_log.
   - Add 'skipped' to the NotificationStatus type (currently: 'stubbed' | 'failed' | 'sent').
   - CRITICAL: The notification_log table has a CHECK constraint that only allows
     ('queued', 'sent', 'delivered', 'failed', 'stubbed'). You MUST update
     database/schema.sql to add 'skipped' to this constraint:
     ALTER TABLE dbo.notification_log DROP CONSTRAINT [the existing check constraint name];
     then re-add with 'skipped' included. Use an idempotent IF NOT EXISTS guard.

6. The loadAcsConfig() function was added in PR 22 — use it here.
   The ISmsService interface is: { sendSms(options: SendSmsOptions): Promise<void> }
   where SendSmsOptions = { to, message, templateId?, memberId?, eventId? }

7. Do NOT change any route files or frontend files.
8. Backend must pass `npm run build` (tsc) with zero errors.
```

---

## PR 24 — Email Templates + Event Notification Dispatch

```
Title: feat: Build email templates and wire event publish/cancel dispatch

Implement the actual notification dispatch when events are published or cancelled.
Create real HTML email templates matching the PHW Alpine tone from the PRD (Appendix B).

Requirements:

PART A — Email Templates:
1. In backend/src/templates/eventInvite.ts create an event invite email template:
   - Subject: "🎣 {{eventTitle}} — {{eventDate}}"
   - HTML body: PHW Alpine branded, includes:
     - Greeting: "Hey PHW Colorado Alpine Family,"
     - Event details block: 📅 Date, ⏰ Time, 📍 Location
     - Description paragraph
     - RSVP link: "{{rsvpUrl}}" (placeholder URL for now)
     - Footer: "Project Healing Waters Fly Fishing — Colorado Alpine Chapter"
     - Unsubscribe note (CAN-SPAM)
   - SMS body (160 char max): "PHW Alpine: {{eventTitle}} on {{eventDate}} at {{location}}. RSVP: {{rsvpUrl}} Reply STOP to opt out"
   - Use the existing renderTemplate() and template interface from NotificationTemplate.ts

2. In backend/src/templates/eventCancellation.ts create a cancellation template:
   - Subject: "[CANCELLED] {{eventTitle}} — {{eventDate}}"
   - HTML body: brief, clear message that the event is cancelled
   - SMS body: "PHW Alpine: {{eventTitle}} on {{eventDate}} has been CANCELLED."

3. Update backend/src/templates/rsvpConfirmation.ts with real HTML content
   (currently a stub). Subject: "RSVP Confirmed: {{eventName}} — {{eventDate}}"

PART B — Event Publish Dispatch:
4. Replace the stub sendEventPublishedNotification() in notifications.ts:
   - CURRENT SIGNATURE: function sendEventPublishedNotification(payload: NotificationPayload): void
     It just does console.log. Change it to an async function that accepts:
     { event_id: string, title: string, event_date: Date|string, location: string|null, description: string|null }
   - Query event_notification_target for the event to get targeted group_ids
   - For each targeted group, query member_group → member to get all members in that group
   - For each member:
     - Send email (always, unless email_opt_out is true)
     - Send SMS (only if sms_opt_in is true AND mobile_phone is not null)
   - Use the eventInvite template with event details as variables
   - Log all sends to notification_log

5. Replace the stub sendEventCancelledNotification() in notifications.ts:
   - CURRENT SIGNATURE: function sendEventCancelledNotification(payload: NotificationPayload): void
     Same pattern — change to async with event record param.
   - Query all members who responded yes/maybe/waitlist for this event
     (from event_response table, JOIN member to get email/phone)
   - Send cancellation email + SMS to each
   - Use the eventCancellation template

6. Update the call sites in backend/src/routes/events.ts:
   - CURRENT CODE (around line 268):
       sendEventPublishedNotification({ eventId: existing.event_id, eventTitle: existing.title });
     and similarly for cancelled.
   - These calls are NOT awaited and use the old NotificationPayload shape.
   - Change to: await sendEventPublishedNotification({ event_id, title, event_date, location, description })
     You'll need to fetch the full event record from the DB before calling (the existing code
     only SELECT's event_id, status, title — add the other columns to that query).
   - The route handler is already async, so adding await is safe.

7. Backend must pass `npm run build` (tsc) with zero errors.
```

---

## PR 25 — Calendar Backend + Frontend Wiring

```
Title: feat: Wire calendar backend DB queries and connect frontend

Replace the placeholder calendar route with real database queries, and connect
the existing CalendarPage.tsx skeleton to live data.

Requirements:

PART A — Backend (backend/src/routes/calendar.ts):
1. Replace the placeholder GET /calendar route with a real DB query:
   - The current file has NO db import, NO auth middleware, NO rate limiter.
     You must add: import { getPool, sql } from '../db';
     import authenticate from '../middleware/auth';
     import { apiLimiter } from '../middleware/rateLimiter';
     import { requireAnyAuthenticatedRole } from '../middleware/rbac';
   - Add middleware to the route: router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, ...)
   - Query the event table for events where event_date falls within the requested month
     (column name is "event_date" — NOT "start_date")
   - For each event, include: event_id, title, event_date, location, status, capacity
   - Include RSVP counts: join event_response to get yes_count, maybe_count, waitlist_count
   - Include notification target group names (LEFT JOIN event_notification_target + [group])
   - Return the events array sorted by event_date ASC
   - Support the existing ?month=YYYY-MM query parameter

PART B — Frontend API:
2. Add a calendar API module at frontend/src/api/calendar.ts:
   - CalendarEvent interface matching the backend response
   - Use "event_date" as the property name (not "start_date")
   - calendarApi.getMonth(month: string) → GET /calendar?month=YYYY-MM
   - Return type: { month: string, range_start: string, range_end: string, events: CalendarEvent[] }

PART C — Frontend CalendarPage:
3. Update frontend/src/pages/CalendarPage.tsx:
   - IMPORTANT: The existing CalendarEvent interface uses "start_date" — change it to
     "event_date" to match the backend schema and API response.
   - Import and call calendarApi.getMonth() on mount and when month changes
   - Wire the existing month-view grid to render real events (MonthView component already exists)
   - Wire the list-view to show events in a table (ListView component already exists)
   - Implement capacity indicators:
     - Green (slots available > 25%)
     - Yellow (≤ 25% remaining)
     - Red (full / no capacity left)
   - Month navigation (prev/next) should refetch data
   - Loading and error states

4. Both frontend and backend must build cleanly (npm run build in both directories).
```

---

## PR 26 — Reports Backend + Admin Summary Grid + CSV Export

```
Title: feat: Wire reports backend with real DB queries, admin summary grid, and CSV export

Replace the placeholder reports route with real database aggregation queries.
Update the frontend ReportsPage to display live data and support CSV export.

Requirements:

PART A — Backend (backend/src/routes/reports.ts):
1. GET /reports/summary — replace placeholder with real DB query:
   - The current file has NO db import, NO auth middleware, NO rate limiter.
     You must add: import { getPool, sql } from '../db';
     import authenticate from '../middleware/auth';
     import { apiLimiter } from '../middleware/rateLimiter';
     import { requireAdmin } from '../middleware/rbac';
   - The current TODO comments reference "start_date" and "event_rsvp" — these are WRONG.
     The actual column is "event_date" and the RSVP table is "event_response".
   - Query events within the date range (from/to query params)
   - For each event: event_id, title, event_date, location, status, capacity
   - RSVP breakdown: COUNT by response (yes, no, maybe, waitlist) from event_response table
   - Aggregates: total_events, total_rsvps, total_attended, avg_fill_rate percentage
   - Require ADMIN role: router.get('/summary', apiLimiter, authenticate, requireAdmin, ...)

2. GET /reports/export — implement real CSV export:
   - Same query as summary but stream as text/csv
   - Columns: event_id, title, event_date, location, status, capacity, yes_count,
     no_count, maybe_count, waitlist_count
   - Proper Content-Disposition header with filename including date range
   - Require ADMIN role

3. Add GET /reports/participation:
   - Query each member's event attendance for a given year
   - Return: member_id, first_name, last_name, events_attended (current year),
     events_attended_prior_year
   - Sorted by events_attended ASC (least participation first)
   - Require ADMIN role

PART B — Frontend:
4. Update frontend/src/api/reports.ts:
   - The current file is minimal (only has a dashboard call to /admin/users).
     REPLACE its contents entirely with proper reports API functions.
   - Wire to the real /reports/summary and /reports/participation endpoints
   - Add a downloadExport(from, to) function that fetches /reports/export and
     triggers a browser file download

5. Update frontend/src/pages/ReportsPage.tsx:
   - Replace usePlaceholderSummary() with a real API call
   - IMPORTANT: The existing EventSummaryRow interface uses "start_date" —
     change it to "event_date" to match the backend
   - Display the summary stats cards with real data
   - Display the events grid with RSVP breakdown columns (Yes/No/Maybe/Waitlist)
   - Add a "Export CSV" button that calls the export endpoint
   - Add a date-range picker (from/to inputs) that refetches data
   - Loading and error states

6. Both frontend and backend must build cleanly.
```

---

## PR 27 — SMS Opt-In/Out UI + Consent Audit Log

```
Title: feat: Add SMS opt-in toggle to member profile and consent audit log UI

Requirements:

PART A — Backend:
1. Add a new endpoint: PATCH /members/:id/sms-consent
   - Body: { sms_opt_in: boolean }
   - When opting IN:
     - Set member.sms_opt_in = 1, sms_opt_in_date = GETUTCDATE()
     - Clear sms_opt_out_date
     - Write to sms_consent_log (action='opt_in', source='manual')
     - If ACS SMS is configured, send the TCPA opt-in confirmation message:
       "PHW Alpine: You've opted in for event notifications. Reply STOP to
        unsubscribe. Msg&data rates may apply."
   - When opting OUT:
     - Set member.sms_opt_in = 0, sms_opt_out_date = GETUTCDATE()
     - Write to sms_consent_log (action='opt_out', source='manual')
   - Require authenticated user (the member themselves OR an ADMIN)

2. Add a new endpoint: GET /members/:id/sms-consent-log
   - Return all sms_consent_log rows for the member, ordered by recorded_at DESC
   - Require ADMIN role

PART B — Frontend:
3. In frontend/src/pages/MembersPage.tsx (or a new MemberDetailPage if cleaner):
   - Add an SMS opt-in/out toggle switch on the member profile/edit view
   - When toggled, call PATCH /members/:id/sms-consent
   - Show current status: "SMS: Opted In (since DATE)" or "SMS: Opted Out"

4. Add a consent audit log section (admin-only):
   - Display a table of sms_consent_log entries for the member
   - Columns: Date, Action (Opt In / Opt Out), Source, Notes

5. Update frontend/src/api/members.ts with the new endpoints.
6. Both frontend and backend must build cleanly.
```

---

## PR 28 — Event Assignment + Attendance Tracking

```
Title: feat: Add event assignment UI and post-event attendance marking

Implement the ability for admins to assign members to events from the RSVP pool
and mark attendance after events complete.

Requirements:

PART A — Backend:
1. SCHEMA CHANGE REQUIRED: The event_assignment table does NOT have 'attended' or
   'attendance_notes' columns. Add them to database/schema.sql:
   - Add an idempotent ALTER TABLE block:
     IF COL_LENGTH('dbo.event_assignment', 'attended') IS NULL
       ALTER TABLE dbo.event_assignment ADD attended BIT NOT NULL DEFAULT 0;
     IF COL_LENGTH('dbo.event_assignment', 'attendance_notes') IS NULL
       ALTER TABLE dbo.event_assignment ADD attendance_notes NVARCHAR(500) NULL;

2. Add new endpoints to backend/src/routes/events.ts (or a new assignments sub-router):
   - GET /events/:id/assignments — list all assignments for an event
     Returns: assignment_id, member_id, first_name, last_name, role, assigned_at, attended
   - POST /events/:id/assignments — assign a member
     Body: { member_id, role: 'MENTOR' | 'PARTICIPANT' }
     Require ADMIN role
   - DELETE /events/:id/assignments/:assignmentId — remove assignment
     Require ADMIN role
   - PATCH /events/:id/assignments/:assignmentId/attendance
     Body: { attended: boolean, attendance_notes?: string }
     Require ADMIN role

3. Add GET /members/:id/participation:
   - Return event count for current year and prior year for a specific member
   - Uses event_assignment table joined with event (where attended=1 and event status=completed)

PART B — Frontend:
4. Create frontend/src/pages/EventAssignmentPage.tsx (or add a tab/section to EventsPage):
   - Shows the RSVP list (yes/maybe/waitlist) for the event
   - "Assign" button next to each member that creates an assignment
   - Shows current assignments in a separate table with role badge
   - For each assignment row: member name, role, participation history
     (events attended this year / last year from GET /members/:id/participation)
   - After event is completed, show attendance checkboxes for each assignment
   - "Save Attendance" button that PATCHes each assignment

5. Add route /events/:id/assign in App.tsx, link from EventsPage detail view.
6. Update frontend/src/api/events.ts with the new assignment endpoints.
7. Both frontend and backend must build cleanly.
```

---

## PR 29 — Dashboard Wiring

```
Title: feat: Wire dashboard with real upcoming events, RSVPs, and stats

Replace the placeholder DashboardPage with live data from existing API endpoints.

Requirements:
1. In frontend/src/pages/DashboardPage.tsx:
   - "Upcoming Events" card: call eventsApi.list('published'), show next 5 events
     with date, title, location, and a link to the event detail
   - "My RSVPs" card: for the logged-in user, show events they've RSVP'd to
     (this may need a new backend endpoint: GET /members/:id/rsvps)
   - "Quick Stats" card (admin only): total members, total events this year,
     upcoming events count — can use existing endpoints

2. If needed, add backend endpoint GET /members/:id/rsvps:
   - Return events the member has responded to, with their response
   - Join event_response with event table
   - Require the authenticated user to be the member themselves or ADMIN

3. Both frontend and backend must build cleanly.
```

---

## PR 30 — TAVF Polish (Auto-Create Event, Notifications, Expiry)

```
Title: feat: TAVF auto-create event on match, posting notifications, 30-day expiry

Complete the TAVF feature per PRD Section 6.4.

Requirements:

1. Auto-create event on match (backend/src/services/tavfService.ts):
   - NOTE: The active TAVF tables are tavf_posting, tavf_application, tavf_match
     (NOT the older take_a_vet_posting table — that one is unused legacy).
   - When createMatch() succeeds, also INSERT a new event record:
     - title: "Take a Vet Fishing — [posting.location]"
     - event_date: posting.event_date
     - location: posting.location
     - capacity: 2 (guide + vet)
     - status: 'published'
   - Update the tavf_posting status to 'filled' if capacity reached

2. Posting notifications (backend/src/services/notifications.ts):
   - Replace notifyNewPosting() stub: when a new TAVF posting is created,
     send an email to all members in the ALL group:
     "New TAVF opportunity: [location] on [date]. View: [link]"
   - Replace notifyMatchConfirmed() stub: email both the guide and the vet
   - Replace notifyMatchCancelled() stub: email both parties

3. Auto-expiry: create backend/src/jobs/tavfExpiryJob.ts:
   - Query all tavf_posting records where status='open' AND
     created_at < DATEADD(day, -30, GETDATE())
     (NOTE: tavf_posting uses GETDATE() not GETUTCDATE() — be consistent)
   - Update their status to 'cancelled'
   - Log count of expired postings
   - Can be run as: node dist/jobs/tavfExpiryJob.js

4. Backend must pass `npm run build` (tsc) with zero errors.
```

---

## PR 31 — Backend Unit Tests

```
Title: test: Add unit tests for events, members, groups, import, and notification routes

Add comprehensive backend unit tests using Jest + supertest (already installed).
Follow the same pattern as the existing backend/src/__tests__/tavf.test.ts.

IMPORTANT — existing test pattern to follow:
  - Tests use supertest with an express app constructed inline
  - Auth middleware is imported but NOT mocked — it passes through in test env
    (NODE_ENV=test makes requireEnv return '' which makes auth skip validation)
  - Service modules are jest.mock'd — tests verify routes call the right services
  - Example: jest.mock('../services/tavfService');
  - Test config: Jest is configured in backend/package.json with preset: "ts-jest",
    testEnvironment: "node"

Requirements:

1. Create backend/src/__tests__/events.test.ts:
   - Test GET /api/v1/events (list, with status filter)
   - Test POST /api/v1/events (create, validation errors)
   - Test PUT /api/v1/events/:id/status (valid transitions, invalid transitions)
   - Mock the database pool (jest.mock('../db'))
   - Mock auth middleware to inject req.user

2. Create backend/src/__tests__/members.test.ts:
   - Test GET /api/v1/members (list, search, pagination)
   - Test POST /api/v1/members (create, duplicate detection)
   - Test PATCH /api/v1/members/:id (update)
   - Test DELETE /api/v1/members/:id (deactivation)

3. Create backend/src/__tests__/import.test.ts:
   - Test POST /api/v1/import/preview (valid CSV, invalid CSV, missing columns)
   - Test POST /api/v1/import/commit/:sessionId (valid session, expired session)

4. Create backend/src/__tests__/groups.test.ts:
   - Test CRUD operations
   - Test system group protection (cannot delete/update system groups)

5. Create backend/src/__tests__/notifications.test.ts:
   - Test AcsEmailService (mock the EmailClient)
   - Test AcsSmsService (mock the SmsClient)
   - Test SMS opt-in guard (skips opted-out members)
   - Test truncateSms helper

6. All tests must pass: npm test
```

---

## Merge Order

```
PR 22  Wire ACS Email           (no dependencies)
PR 23  Wire ACS SMS             (depends on PR 22 for loadAcsConfig)
PR 24  Templates + Dispatch     (depends on PR 22+23 for real sending)
PR 25  Calendar                 (independent of 22-24)
PR 26  Reports + CSV Export     (independent of 22-24)
PR 27  SMS Consent UI           (depends on PR 23 for opt-in confirmation SMS)
PR 28  Event Assignment         (independent)
PR 29  Dashboard Wiring         (depends on PR 28 for participation data)
PR 30  TAVF Polish              (depends on PR 24 for notifications)
PR 31  Backend Tests            (depends on all code PRs being merged)
```

Parallelizable groups (can run simultaneously if agents support it):
- **Group A:** PR 22 → 23 → 24 → 27 → 30 (notification pipeline chain)
- **Group B:** PR 25, PR 26, PR 28 (can run in parallel after main is stable)
- **Group C:** PR 29 (after 28)
- **Group D:** PR 31 (after everything)
