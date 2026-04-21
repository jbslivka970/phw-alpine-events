# PHW Alpine Events - PRD v1.2 Reconciliation and Review

| Field | Value |
|---|---|
| Document Version | 1.2 Reconciliation Update |
| Date | 2026-04-21 |
| Scope | Repository-wide product, security, accessibility, and documentation review |
| Purpose | Replace stale PRD status assumptions with current code-verified status and a forward work plan |
| Supersedes As Source of Truth | docs/prd-v1_2-full-compare-20260401.md, docs/feature-gap-inventory-20260409.md, docs/project-closure-review-20260409.md, docs/v2-roadmap-20260414.md |

## 1. Executive Summary

The attached PRD v1.2 is no longer an accurate implementation-status document.

As of 2026-04-21, the repository implements substantially more than the PRD and several April follow-up docs claim. The current codebase includes inbound SMS RSVP handling, STOP/HELP processing, automated reminders, tokenized RSVP, email unsubscribe, waitlist lifecycle automation, template admin, ICS export, delivery reporting, AI-assisted invite/equity flows, first-time onboarding, advanced notification channel preferences, and post-event thank-you notifications.

The remaining gaps are now concentrated in four areas:

1. Accessibility and ADA remediation on the frontend.
2. Operational fail-closed behavior for notifications, observability verification, and cleanup of partially completed secrets rollout documentation.
3. Repository/security hygiene in utility scripts and tracked artifacts.
4. Product polish items such as managed image upload, calendar deep-linking, delivery report polish, and additional test depth.

## 2. Review Inputs

### 2.1 Documents Reviewed

1. docs/launch-readiness-prd-traceability-20260320.md
2. docs/prd-v1_2-full-compare-20260401.md
3. docs/feature-gap-inventory-20260409.md
4. docs/project-closure-review-20260409.md
5. docs/v2-roadmap-20260414.md
6. docs/next-wave-task-list.md
7. docs/template-governance-policy.md
8. docs/app-insights-alert-baseline.md
9. docs/key-vault-migration-plan.md
10. PHW_Alpine_Events_PRD_v1.2.md (attached source PRD)

### 2.2 Code Surfaces Sampled

1. backend/src/index.ts
2. backend/src/routes/events.ts
3. backend/src/routes/rsvp.ts
4. backend/src/routes/sms.ts
5. backend/src/routes/preferences.ts
6. backend/src/routes/tavf.ts
7. backend/src/routes/reports.ts
8. backend/src/routes/health.ts
9. backend/src/services/notifications.ts
10. backend/src/services/emailPreferenceLinkService.ts
11. frontend/src/App.tsx
12. frontend/src/components/Layout.tsx
13. frontend/src/pages/CalendarPage.tsx
14. frontend/src/pages/EventsPage.tsx
15. frontend/src/pages/ImportPage.tsx
16. frontend/src/pages/TemplatesPage.tsx
17. frontend/src/pages/AdminPage.tsx
18. frontend/src/pages/NotificationPreferencesPage.tsx
19. frontend/src/pages/FirstTimeOnboardingPage.tsx
20. frontend/src/styles/theme.ts

### 2.3 Current Validation Performed

1. Current dependency audit: no current high/critical production vulnerabilities in backend or frontend.
2. Workspace diagnostics sweep: only workflow-context warnings remained in GitHub Actions YAML.
3. Direct verification of feature claims against code, not just historical documents.
4. Production verification confirmed `status=ok`, `nodeEnv=production`, real email/SMS notification channels, telemetry configured, Key Vault references required/configured, and `NOTIFICATIONS_STRICT_MODE` currently disabled.

## 3. Reconciled Status vs PRD v1.2

The table below resolves the most important stale PRD gap claims against the current repository.

| PRD Item | Older Document Status | Current Verified State | Evidence | PR Alignment |
|---|---|---|---|---|
| Inbound SMS RSVP parsing | Not implemented / partial in older docs | Implemented | backend/src/routes/sms.ts | LR-01 / PR-33 |
| STOP and HELP handling | Not implemented / partial in older docs | Implemented | backend/src/routes/sms.ts | LR-01 / PR-33 |
| Automated reminders | Not implemented in PRD v1.2 | Implemented | backend/src/index.ts, backend/src/jobs/reminderJob.ts | LR-03 / PR-34 |
| Tokenized one-click RSVP | Not implemented in PRD v1.2 | Implemented | frontend/src/App.tsx, backend/src/routes/sms.ts, backend/src/services/rsvpLinkService.ts | LR-04 / PR-35 |
| Email unsubscribe workflow | Not implemented in PRD v1.2 | Implemented | backend/src/routes/preferences.ts, backend/src/services/emailPreferenceLinkService.ts | LR-05 / PR-36 |
| Event update notifications | Not implemented in PRD v1.2 | Implemented | backend/src/routes/events.ts, backend/src/services/notifications.ts | LR-06 / PR-37 |
| Waitlist lifecycle automation | Not implemented in PRD v1.2 | Implemented | backend/src/index.ts, backend/src/jobs/waitlistLifecycleJob.ts | LR-07 / PR-38 |
| Template admin UI | Not implemented in PRD v1.2 | Implemented | backend/src/routes/templates.ts, frontend/src/pages/TemplatesPage.tsx | LR-08 / PR-41 |
| Channel preferences model | Nice-to-have only in PRD | Implemented | backend/src/routes/members.ts, frontend/src/pages/NotificationPreferencesPage.tsx | LR-10 / PR-44 |
| ICS export | Not implemented in PRD v1.2 | Implemented | backend/src/routes/events.ts, frontend/src/pages/CalendarPage.tsx | LR-14 / PR-42 |
| Delivery reporting UI | Not implemented in PRD v1.2 | Implemented baseline, polish still optional | backend/src/routes/reports.ts, frontend/src/pages/ReportsPage.tsx | LR-15 / PR-42b |
| AI invite generation | Not implemented in PRD v1.2 | Implemented with provider fallback | backend/src/services/aiInviteService.ts, frontend/src/pages/EventsPage.tsx, frontend/src/pages/AdminPage.tsx | LR-16 / PR-39 |
| AI assignment equity recommendations | Not implemented in PRD v1.2 | Implemented | backend/src/routes/events.ts, frontend/src/api/events.ts | LR-17 / PR-40 |
| First-time onboarding flow | Marked not implemented in docs dated 2026-04-01 | Implemented | frontend/src/App.tsx, frontend/src/pages/FirstTimeOnboardingPage.tsx | Unmapped in current artifact trail |
| Post-event thank-you notifications | Marked not implemented in docs dated 2026-04-01 and 2026-04-09 | Implemented | backend/src/routes/events.ts, backend/src/services/notifications.ts, backend/src/templates/eventThankYou.ts | Unmapped in current artifact trail |
| Event invite map/photo/coordinator support | Treated as open in v2 roadmap | Implemented in current invite template and notification variables | backend/src/templates/eventInvite.ts, backend/src/services/notifications.ts | Unmapped in current artifact trail |
| Key Vault migration | Planned only | Partial production implementation verified; documentation/completeness follow-up remains open | docs/key-vault-migration-plan.md, docs/production-verified-findings-20260421.md | LR-13 / PR-46 |
| App Insights alert verification | Partial | Partial | docs/app-insights-alert-baseline.md, backend/src/routes/health.ts | LR-12 / PR-45 |
| Notification service branch-depth tests | Partial | Still partial | docs/launch-readiness-prd-traceability-20260320.md, backend/src/__tests__/notifications.test.ts | LR-11 / PR-32 |
| Event imagery/attachments | Historically described as gap | Partial: URL-based photo support exists, managed upload/attachment workflow does not | frontend/src/pages/EventsPage.tsx, backend/src/templates/eventInvite.ts | Unmapped in current artifact trail |

## 4. Feature-to-PR Alignment

### 4.1 Wave 2 PRs (Documented in PRD v1.2)

| PR | Feature Slice | Current State |
|---|---|---|
| PR 22 | ACS email delivery | Implemented |
| PR 23 | ACS/SMS plumbing and skipped/stubbed log handling | Implemented |
| PR 24 | Event publish/cancel dispatch and templates | Implemented |
| PR 25 | Calendar backend and frontend | Implemented |
| PR 26 | Reports backend, summary grid, exports | Implemented |
| PR 27 | SMS consent UI and audit log | Implemented |
| PR 28 | Event assignment and attendance | Implemented |
| PR 29 | Dashboard wiring | Implemented |
| PR 30 | TAVF polish | Implemented |
| PR 31 | Backend unit tests | Partial follow-up still open |

### 4.2 Launch Hardening PRs (Documented in Launch Traceability)

| PR | Work Item | Current State |
|---|---|---|
| PR-32 | Notification service unit-test completion | Partial |
| PR-33 | Inbound SMS path | Implemented |
| PR-33a | SMS compliance smoke suite and alerts | Implemented, evidence cadence still ongoing |
| PR-34 | Reminder automation | Implemented |
| PR-35 | Tokenized RSVP | Implemented |
| PR-36 | Email unsubscribe | Implemented |
| PR-37 | Event update notifications | Implemented |
| PR-38 | Waitlist lifecycle | Implemented |
| PR-39 | AI invite generation | Implemented |
| PR-40 | AI equity recommendations | Implemented |
| PR-41 | Template admin UI | Implemented |
| PR-42 | ICS export | Implemented |
| PR-42b | Delivery report UX polish | Partial |
| PR-43 | Regional admin To-line configuration | Implemented |
| PR-44 | Channel preferences | Implemented |
| PR-45 | App Insights baseline | Partial |
| PR-46 | Key Vault migration plan | Partial prod implementation / documentation follow-up open |

### 4.3 Additional Implemented Features Not Formally PR-Mapped in Current Artifacts

These are present in code, but the reviewed documents do not preserve a clean PR ID for them.

1. First-time onboarding route and page for invite/SMS/sign-in entry.
2. Post-event thank-you notifications when events move to completed.
3. Event invite email support for map links, event photo sections, and coordinator details.
4. Editable AI description and invite drafts in the event editor.
5. Surfaced AI image suggestions and map links in the event editor.
6. Public privacy, terms, and SMS program pages.
7. Retention job scheduler plus admin preview endpoint.
8. Health/startup diagnostics for auth, notifications, telemetry, and Key Vault reference state.
9. TAVF self-service notification subscription preference.

## 5. New Features Not Previously Identified in PRD v1.2

The current repository contains meaningful functionality that is not cleanly represented in the attached PRD v1.2.

### 5.1 Product and User Experience Additions

1. First-time onboarding page for invite and SMS users.
2. Advanced channel preference model (`email_only`, `sms_only`, `both`).
3. TAVF notification subscription preference for members.
4. Editable AI-assisted description polishing and invite drafting.
5. AI image suggestion surfacing and direct map-link surfacing in the event editor.
6. Post-event thank-you notifications.

### 5.2 Compliance and Trust Additions

1. Public privacy policy page.
2. Public terms page.
3. Public SMS program page.
4. Email unsubscribe audit logging.
5. Inbound SMS audit logging.

### 5.3 Operational and Admin Additions

1. Startup diagnostics endpoint exposing configuration health without exposing secrets.
2. Delivery-log provider status lookup support.
3. Retention preview and scheduled retention job scaffold.
4. App-role management/admin user management surfaces.

## 6. Confirmed Remaining Product Gaps

This section captures the feature-level gaps that still remain after reconciling stale docs.

| Priority | Gap | Current State | Notes |
|---|---|---|---|
| P1 | Managed image upload / attachment workflow | Not implemented | Current implementation is URL-based (`photo_url`) rather than managed upload/storage |
| P1 | Calendar event deep-linking from month/list view | Incomplete | Calendar event open action currently navigates to `/events` generically instead of opening a specific event |
| P1 | Delivery report polish | Partial | Baseline reporting exists; optional export/chart and UX polish remain |
| P1 | Notification service branch-depth test coverage | Partial | Core route/job coverage exists; service edge-branch depth is still open |
| P2 | AI copy quality tuning and multi-variation generation | Partial | AI generation is implemented, but deterministic fallback and quality tuning remain future-work candidates |
| P2 | Managed event-image experience | Partial | URL field exists; no upload workflow, media governance, or storage management exists in reviewed code |

## 7. Security Findings

Historical security findings in docs dated 2026-04-09 were partially stale when re-checked against current code and current production configuration. Production verification confirmed real notification channels, telemetry configured, and Key Vault references required/configured for core checked secrets. The following issues remain material today.

### 7.1 Active Findings

| Severity | Finding | Evidence | Risk | Recommended Action |
|---|---|---|---|---|
| Medium | Tracked release/screenshot artifacts remain in Git | root tracked `frontend-release.zip`; tracked `tmp-rbac-*.png`; .gitignore ignores patterned release files but not these exact artifacts | Repository bloat, possible leakage of internal UI/screenshots, poor release hygiene | Remove tracked artifacts from Git, add explicit ignore rules for `frontend-release.zip` and `tmp-rbac-*.png` |
| Medium | Migration utility reads local `backend/.env` and shells out with parsed Key Vault values | scripts/run-migration.js | Couples secret handling to local ignored files and leaves room for command-injection-style abuse in a privileged maintenance path | Replace shell string execution with argument-safe invocation and move migration config to explicit environment/CLI inputs |
| Medium | Notification delivery can silently degrade to stub mode unless strict mode is enabled | backend/src/services/notifications.ts | Production notifications can fall back to stub logging instead of hard failure if provider config drifts and `NOTIFICATIONS_STRICT_MODE` is not enabled | Enable strict mode in production and fail publish/reminder flows when real providers are unavailable |
| Medium | Startup health can still report overall `ok` when notifications are stubbed if strict mode is off | backend/src/routes/health.ts | Operational dashboards may under-report real delivery risk | Include notification mode in overall degraded status for production, or require strict mode in production |
| Medium | Delivery reporting currently counts `stubbed` as successful/delivered | backend/src/routes/reports.ts | Coverage/trend reports can overstate actual notification success and compliance evidence | Separate `stubbed` from true delivery success in trends, reminder duplication checks, and coverage summaries |
| Low | Email preference tokens reuse RSVP token secret when a dedicated secret is absent | backend/src/services/emailPreferenceLinkService.ts | Production currently works because the shared RSVP secret is present, but the fallback still increases blast radius and couples rotations | Require a dedicated `EMAIL_PREFERENCE_TOKEN_SECRET` in production |
| Low | Workflow diagnostics still show unresolved variable/secret context warnings | .github/workflows/ci-cd.yml, .github/workflows/backend-rollback.yml | Noise can hide real workflow issues | Clean up workflow schema/tooling configuration and verify required repository variables/secrets are declared |

### 7.2 Security Controls Observed as Positive

1. JWT-based auth with issuer/audience validation and role extraction.
2. Role guards on TAVF mutation routes and RSVP list access.
3. CORS now fails closed when `CORS_ORIGIN` is unset.
4. Helmet and rate limiting are enabled.
5. Local E2E auth bypass is gated away from production.
6. Current `npm audit --omit=dev --audit-level=high` returned no high/critical production vulnerabilities.

## 8. Accessibility and Compliance Findings

### 8.1 ADA / WCAG Frontend Findings

| Severity | Finding | Evidence | Risk | Recommended Action |
|---|---|---|---|---|
| High | Calendar month view lacks grid/calendar semantics | frontend/src/pages/CalendarPage.tsx | Screen-reader and keyboard users cannot reliably understand the calendar structure | Rebuild the month view using proper grid semantics (`role="grid"`, row/cell semantics, accessible day labels, event labels) |
| High | Calendar event "open" action is not event-specific | frontend/src/pages/CalendarPage.tsx | Keyboard and screen-reader users activate event chips/buttons but are sent to a generic page instead of a specific event context | Deep-link to the selected event or open a proper event detail dialog |
| High | Event modal has dialog semantics but no verified focus-trap or Escape handling and form fields are not explicitly label-bound with ids | frontend/src/pages/EventsPage.tsx | Keyboard users may lose focus context; screen readers do not get reliable label associations | Add focus management matching MembersPage, support Escape close, and bind every label with `htmlFor`/`id` |
| Medium | Template editor relies heavily on placeholders instead of explicit bound labels | frontend/src/pages/TemplatesPage.tsx | Screen-reader context is weaker than necessary for core admin workflows | Add visible labels and `id` bindings for template name, subject, body, and rollback reason |
| Medium | Admin app-role assignment email field is placeholder-led and not label-bound | frontend/src/pages/AdminPage.tsx | Accessibility of a sensitive admin workflow depends on placeholder text | Add a real label bound to the email input |
| Medium | Import tables lack captions and explicit `scope` attributes on headers | frontend/src/pages/ImportPage.tsx | Screen readers get weaker table context for conflict resolution/history tables | Add `<caption>` and `scope="col"` on header cells |
| Medium | RSVP theme tokens likely need a formal contrast audit | frontend/src/styles/theme.ts | Some state-color pairings may undershoot WCAG AA on light tinted backgrounds | Run a real contrast audit and adjust maybe/no state token pairs if needed |

### 8.2 Positive Accessibility Patterns Already Present

1. Skip link is present in the global layout.
2. Footer includes an accessibility contact notice.
3. Members modal implements stronger dialog focus handling and Escape support than other screens.

### 8.3 Operational Compliance and Governance Findings

| Priority | Finding | Evidence | Recommended Action |
|---|---|---|---|
| P1 | App Insights baseline exists but alert-policy verification is still partial | docs/app-insights-alert-baseline.md, backend/src/routes/health.ts | Assign owner, verify action group delivery, and document evidence |
| P1 | Key Vault rollout is active in production for core checked secrets, but documentation and completeness evidence remain open | docs/key-vault-migration-plan.md, docs/production-verified-findings-20260421.md | Document current rollout state, verify remaining secret coverage, and retain cutover evidence |
| P1 | Template governance policy exists, but execution cadence is manual | docs/template-governance-policy.md | Assign primary/backup owners and track weekly/monthly reviews |
| P1 | Compliance smoke evidence cadence and archival ownership are still process-driven rather than enforced | docs/sms-compliance-smoke-runbook.md, docs/email-unsubscribe-smoke-runbook.md, docs/tokenized-rsvp-smoke-runbook.md | Assign owners and archive outputs on a predictable cadence |
| P2 | Toll-free/carrier verification state should be captured in one current ops document | referenced in older PRD/docs, not fully reconciled in current source-of-truth docs | Add explicit current-state note in operations documentation |

## 9. Documentation Contradictions Resolved by This Review

The following claims in older documents are now known to be stale relative to the current repository:

1. "First-time onboarding is not implemented" - stale; route and page exist.
2. "Post-event thank-you notifications are not implemented" - stale; completion path and thank-you template exist.
3. "Invite templates still lack map/photo/coordinator support" - stale; current invite template includes those sections.
4. "AI preview is read-only and image suggestions are not surfaced" - stale; current event editor supports editable drafts, image suggestions, and map link surfacing.
5. April 9 security notes about permissive CORS, overly broad TAVF mutation access, RSVP PII exposure, and critical audit issues are not reproduced in the current code review and should be considered closed unless reopened by fresh evidence.

## 10. Recommended Future Work

### 10.1 P0 - Next Delivery Window

1. Remove tracked release archives/screenshots and extend `.gitignore` to cover exact artifact names still slipping through.
2. Harden or retire `scripts/run-migration.js` in favor of explicit, safer migration execution.
3. Make production notifications fail closed by enabling `NOTIFICATIONS_STRICT_MODE` and removing `stubbed` from success semantics in reports.
4. Finish production schema reconciliation and retire runtime column-support fallbacks after verification.

### 10.2 P1 - Launch Hardening

1. Remediate ADA issues in CalendarPage, EventsPage modal, TemplatesPage, AdminPage, and ImportPage.
2. Complete notification service branch-depth tests.
3. Verify App Insights alerting end-to-end and assign compliance evidence owners.
4. Document and complete remaining Key Vault rollout coverage.
5. Make calendar event open actions event-specific.

### 10.3 P2 - Product Polish

1. Move from URL-only event imagery to a managed upload/storage model if true attachments remain a product requirement.
2. Continue AI content quality tuning and consider multi-variation invite generation.
3. Polish delivery reporting UX and clearly distinguish simulated/stubbed sends from real delivery.

## 11. Recommended Source of Truth

Use this document as the current implementation-status and review baseline for planning.

Use `docs/production-verified-findings-20260421.md` as the implementation-facing findings and cleanup backlog.

Keep the older April documents for historical traceability, but do not use them as the primary implementation-status source without reconciling them against current code.