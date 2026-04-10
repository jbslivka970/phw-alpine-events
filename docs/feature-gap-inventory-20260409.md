# Feature Gap Inventory (Reconciled from Older Docs)

Date: 2026-04-09
Scope: Consolidated from older planning/compare documents plus current closure context.

## 1) Confirmed Remaining Feature Gaps

These are explicit product features still listed as not implemented in the latest PRD compare document.

1. GAP-15: Post-event thank-you notifications.
2. GAP-16: Event photo attachments.

GAP-17 update (2026-04-09): Implemented.
- Added dedicated first-time onboarding route/page and entry links from RSVP and login surfaces.
- Frontend evidence:
	- `frontend/src/pages/FirstTimeOnboardingPage.tsx`
	- `frontend/src/pages/PublicRsvpPage.tsx`
	- `frontend/src/pages/LoginPage.tsx`
	- `frontend/src/App.tsx`

Source: `docs/prd-v1_2-full-compare-20260401.md` (Section 2.3, Nice-to-Have).

## 2) Feature-Adjacent Quality Gaps (Not New Features)

These are not missing core capabilities, but they are still open quality/depth items that can look incomplete during validation.

1. GAP-13: Notification service unit-test depth is partial (service branch-depth hardening still open).
2. Shared-email matching behavior remains marked partial in older v1.1 realignment notes (edge-case UAT emphasis).
3. Inbound STOP/Event Grid production topology verification is marked partial/open in older v1.1 realignment notes.
4. Full inbound RSVP disambiguation production wiring verification is marked partial/open in older v1.1 realignment notes.

Sources:
- `docs/prd-v1_2-full-compare-20260401.md` (Section 2.2, GAP-13)
- `docs/prd-v1_1-realignment-20260320.md` (Section 3.1 and 3.2)

## 3) Ops/System Gaps Often Confused as Feature Gaps

These are real open items, but they are operational/governance/reliability, not missing user-facing product workflows.

1. Retention policy production rollout and delete-mode governance execution.
2. Compliance smoke evidence cadence and archival process ownership.
3. Template governance execution cadence.
4. CI/runtime modernization follow-through.
5. Frontend performance/bundle-size tuning pass.
6. App Insights alerting confirmation and tightening.
7. Key Vault migration.

Source: `docs/prd-v1_2-full-compare-20260401.md` (Sections 4 and 2.3).

## 4) Legacy Items Marked In Progress in Older Plans (Likely Stale)

The launch plan document from 2026-03-20 still marks LR-01 through LR-17 as "In Progress", but later compare/closure docs indicate the major roadmap capabilities were implemented.

Examples now treated as implemented in newer docs:

1. Inbound SMS processing and STOP/HELP handling.
2. Automated reminders and waitlist lifecycle.
3. Tokenized RSVP and email unsubscribe.
4. Templates admin CRUD/history/rollback.
5. ICS export and delivery reporting.
6. AI invite and assignment equity recommendations.

Sources:
- `docs/launch-readiness-prd-traceability-20260320.md` (table marks many items In Progress)
- `docs/prd-v1_2-full-compare-20260401.md` (Sections 2.1/2.2 mark many items Implemented)
- `docs/project-closure-review-20260409.md` (Executive + PRD mapping snapshot)

## 5) Codebase Stub Signals (Configuration-Dependent)

These are not necessarily missing features, but they can produce "stubbed" behavior in lower-config environments and may look unfinished.

1. Notification service supports stub mode when real email/SMS providers are not configured.
2. Reports include `stubbed` status values for notification outcomes.
3. Environment example explicitly notes optional provider config with stubs active.

Representative sources:
- `backend/src/services/notifications.ts`
- `backend/src/routes/reports.ts`
- `backend/.env.example`

## 6) Practical Interpretation

Current best read from reconciled docs:

1. Core launch features are implemented.
2. Remaining true product feature gaps are two Nice-to-Have items (thank-you notifications and photo attachments).
3. Most other open items are operations, test depth, or environment-hardening tasks.

## 7) Suggested Next Cleanup

To avoid recurring confusion, update `docs/launch-readiness-prd-traceability-20260320.md` statuses from historical "In Progress" to reconciled state and link this inventory as the current gap index.
