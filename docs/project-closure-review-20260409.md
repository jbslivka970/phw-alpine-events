# PHW Alpine Events - Project Closure Review

Date: 2026-04-09
Prepared by: GitHub Copilot (GPT-5.3-Codex)
Scope: Repository-wide review sweep, PRD traceability reconciliation, conversation-derived gap tracking, security review, and code-quality findings.

## 1) Executive Summary

The project is functionally close to PRD v1.2 completion, and the latest production deployment completed successfully.

Most roadmap capabilities are implemented (events/TAVF workflows, reminders, inbound SMS handling, tokenized RSVP, unsubscribe, templates, reports, ICS, AI assist flows). A remediation pass on 2026-04-09 closed the highest-priority security/code gaps identified in this review.

Remaining work is now split between:

1. Authorization and privacy hardening found in this review.
2. Operational sign-off items already identified in PRD compare docs.
3. Quality follow-ups (type/test hygiene and dependency patching).

## 2) Evidence Sources

Primary docs reviewed:

1. docs/launch-readiness-prd-traceability-20260320.md
2. docs/prd-v1_2-full-compare-20260401.md
3. docs/next-wave-task-list.md
4. README.md

Primary code surfaces reviewed:

1. backend/src/routes/tavf.ts
2. backend/src/routes/rsvp.ts
3. backend/src/middleware/rbac.ts
4. backend/src/index.ts
5. frontend/src/pages/TavfListPage.tsx
6. frontend/src/pages/EventsPage.tsx
7. frontend/src/main.tsx

Automated checks sampled during this review:

1. Full workspace diagnostics (compiler/editor problems panel)
2. npm audit --omit=dev --audit-level=high (backend and frontend)

Conversation-derived context included:

1. Recently deployed fixes for TAVF subscription toggle, Events RSVP UX/state, and chunk-load blank-screen recovery.

## 3) PRD Mapping Snapshot

Reference baseline: docs/prd-v1_2-full-compare-20260401.md.

Current status summary:

1. Implemented and in production (as documented):
   - Inbound SMS parse and STOP/HELP handling
   - Automated reminders and waitlist lifecycle
   - Tokenized RSVP and public RSVP experience
   - Email unsubscribe workflow
   - Templates admin CRUD/history/rollback
   - Delivery reporting, ICS export, AI invite/equity assist

2. Implemented recently in this conversation and deployed:
   - TAVF subscription preference UX/API usage stabilization
   - Events RSVP per-card state (no global role bleed)
   - RSVP backend member-id fallback resolution
   - Frontend chunk-load recovery for stale asset/MIME mismatch blank screen

3. Remaining PRD/ops items still open (from v1.2 compare):
   - Retention policy production rollout and delete-mode governance
   - Ongoing compliance evidence cadence and archival
   - Service-level notification test-depth hardening
   - CI/runtime modernization and frontend performance tuning
   - Nice-to-have items (thank-you notifications, event photo attachments, onboarding polish, Key Vault and alert-policy tightening)

## 4) Security Findings (Ordered by Severity)

### S1 - High - Missing authorization guards on multiple TAVF sensitive endpoints

Evidence:

1. backend/src/routes/tavf.ts:204 (delete posting)
2. backend/src/routes/tavf.ts:225 (list applications for posting)
3. backend/src/routes/tavf.ts:280 (update application status)
4. backend/src/routes/tavf.ts:335 (create match)
5. backend/src/routes/tavf.ts:371 (cancel match)

Issue:
These routes run under authenticate middleware only (not role/ownership guarded), allowing any authenticated user to perform creator/admin actions and view/modify sensitive workflow state.

Risk:

1. Unauthorized deletion or status tampering.
2. Workflow integrity loss for guide/veteran matching.
3. Potential exposure of applicant-level data to unintended users.

Recommended fix:

1. Require requireEventCreatorOrAdmin for mutation endpoints.
2. Add ownership constraints where role alone is insufficient.
3. Add route tests asserting 403 for unauthorized roles.

### S2 - High - RSVP list endpoint exposes member PII to any authenticated role

Evidence:

1. backend/src/routes/rsvp.ts:75 (GET list uses requireAnyAuthenticatedRole)
2. backend/src/routes/rsvp.ts:84 (returns email and mobile_phone)

Issue:
Any authenticated role can read RSVP attendee contact details for any event.

Risk:

1. Privacy/data-minimization violation.
2. Potential contact-data misuse.

Recommended fix:

1. Restrict GET RSVP list to admin/event creator (or event owner).
2. Return redacted/member-safe fields for non-privileged roles if list access is needed.
3. Add tests for access control and field redaction.

### S3 - High - Backend dependency vulnerability (critical advisory)

Evidence:

1. backend npm audit result: axios <1.15.0 critical SSRF advisory (GHSA-3p68-rc4w-qgx5)

Issue:
A production dependency path includes vulnerable axios version.

Risk:

1. SSRF vector under specific proxy/no_proxy normalization conditions.

Recommended fix:

1. Upgrade axios to patched range (>=1.15.0) and refresh lockfile.
2. Re-run npm audit and regression tests in CI.

### S4 - Medium - CORS permissive fallback when CORS_ORIGIN unset

Evidence:

1. backend/src/index.ts:41
2. backend/src/index.ts:61
3. backend/src/index.ts:65

Issue:
If CORS_ORIGIN is empty, corsOptions becomes undefined and Express CORS middleware defaults to permissive behavior.

Risk:

1. Cross-origin API access broader than intended if environment configuration drifts.

Recommended fix:

1. Fail-fast on startup in non-local environments when CORS_ORIGIN is missing.
2. Default to deny-all rather than allow-all when unset.

## 5) Code Review Findings (Non-Security)

### C1 - Medium - TAVF create action is always shown in UI

Evidence:

1. frontend/src/pages/TavfListPage.tsx:51 (const canCreateTavfPostings = true)

Issue:
The create button visibility is hardcoded true instead of role-derived.

Impact:

1. UX inconsistency and potential failed navigation/authorization confusion.

Recommended fix:

1. Use role-aware auth helper (for example canCreateEvents/canCreateTavfPostings from auth context).

### C2 - Medium - Existing type mismatch in E2E role matrix tests

Evidence:

1. tests/e2e/api-role-matrix.spec.ts:170 (RoleCapabilities missing canPostEvents)

Issue:
Current diagnostics indicate the E2E role-matrix typing contract is out of sync.

Impact:

1. Reduced confidence in role-capability regression harness.

Recommended fix:

1. Align RoleCapabilities return shape and rerun e2e matrix tests.

### C3 - Low - Workflow diagnostics show unresolved context warnings in editor

Evidence:

1. .github/workflows/ci-cd.yml (multiple vars/secrets context warnings)

Issue:
Editor diagnostics flag GitHub context symbols as potentially invalid.

Impact:

1. Noise and potential masking of real workflow issues.

Recommended fix:

1. Validate schema/tooling settings for workflow linting context.
2. Keep as documentation/lint cleanup unless run-time failures appear.

## 6) Operational and Release Readiness Status

Deployment status for latest fix set:

1. Workflow run 24214769055 completed with success.
2. build, deploy, and deploy_frontend jobs succeeded.

Open operational readiness items (P0/P1):

1. Retention rollout evidence package and controlled delete enablement.
2. Compliance smoke evidence cadence and archival process ownership.
3. Security hardening fixes S1/S2/S3 before final launch sign-off.

## 7) Gap Register (What Remains)

Priority P0 (must address before final closure):

1. None open from this review after 2026-04-09 remediation.

Priority P1:

1. S4 CORS fail-closed behavior when env is incomplete.
2. C2 E2E role-capability type drift fix.
3. Notification service branch-depth test expansion (from PRD compare).

Priority P2:

1. C1 TAVF create-button role gating cleanup.
2. Nice-to-have PRD enhancements still deferred.

## 8) Suggested Closure Plan

1. Security patch sprint (S1/S2/S3) with explicit regression tests.
2. Operational sign-off sprint for retention/compliance evidence package.
3. Quality sprint for role-matrix typing and service-level test depth.
4. Final launch gate review using this document plus runbook evidence links.

## 9) Closure Decision

Current recommendation: Security/code-review closure items from this review are completed and validated via local build/test plus dependency audit checks.

Recommended next state: proceed to final launch sign-off package focused on operational evidence (retention/compliance cadence/governance artifacts).

## 10) Remediation Update (2026-04-09)

Completed in codebase:

1. Added role-based protection to sensitive TAVF mutation/read endpoints and constrained non-creator application visibility.
2. Restricted RSVP list API access to event-creator/admin roles.
3. Added backend dependency override and refreshed lockfile to clear axios critical advisory.
4. Updated backend CORS behavior to fail closed when CORS origin allowlist is not configured.
5. Fixed E2E role-capability typing drift.
6. Corrected TAVF create-button UI role gating.

Validation evidence:

1. backend build: pass
2. frontend build: pass
3. backend tests: pass (`tavf.test.ts`, `events.test.ts`)
4. backend production dependency audit: pass (`npm audit --omit=dev --audit-level=high`)
