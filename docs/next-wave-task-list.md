# Next Wave Task List

Date: 2026-03-19
Context: Planned immediately after Wave 1 lock, push, and production deployment.

## Wave 2 Goals

1. Complete CSV import hardening and admin review workflow for shared-email conflicts.
2. Finish RSVP and SMS production hardening, including disambiguation flows for multiple active events.
3. Expand event operations with update/cancel notifications and waitlist auto-promotion.
4. Progress Take a Vet Fishing workflows from baseline to production-ready UX.
5. Raise production confidence with focused smoke scripts and CI validation.

## Prioritized Tasks

## P0 (Start Immediately)

Status (2026-03-31): Complete

1. CSV import conflict review UI
- Build preview state for records with same email but different names.
- Add approve/create/skip actions in import commit flow.
- Add tests for composite-key match behavior and manual-edit precedence.

2. SMS RSVP disambiguation
- Implement explicit pending-event selection by reply index when multiple active events exist.
- Add robust HELP and invalid command responses.
- Add route and service tests for edge cases.

3. Event update and cancellation notifications
- Trigger delta-aware update notifications from event edit flow.
- Trigger cancellation notifications to responders by original channel availability.
- Ensure notification logs include reason and operation type.

4. Waitlist auto-promotion
- Promote first eligible waitlist member when a slot opens.
- Add acceptance window and fallback to next candidate.
- Record all promotions in notification and response logs.

P0 verification snapshot (2026-03-31):

- Frontend flow harness covers TAVF, Events, and Import conflict workflows via `npm --prefix frontend run test:flows`.
- CI now runs frontend flow harness as a required build step in `.github/workflows/ci-cd.yml`.
- Backend targeted suites for import/events/waitlist promotion pass.

## P1 (Second Batch)

1. Import report quality
- Add downloadable import results with row-level error summary.
- Add import history filters by date and operator.

2. Take a Vet Fishing enhancements
- Add posting status transitions with expiration and matched summaries.
- Add notification preferences support for TAVF postings.

3. Frontend bundle and performance improvements
- Split heavy dashboard bundle sections with route-based dynamic imports.
- Reduce first-load JS size and keep Vite warning below threshold target.

## P2 (Planning/Prep)

1. CI deployment reliability
- Add release packaging step that excludes unnecessary backend artifacts.
- Add optional post-deploy health gate in workflow.

2. Branch hygiene
- Review legacy local branches and archive/delete those fully superseded.
- Keep only active work branches for current wave.

## Suggested Execution Order

1. CSV import conflict review UI
2. SMS disambiguation flow
3. Event update/cancel notifications
4. Waitlist auto-promotion
5. TAVF and performance improvements
6. CI and branch hygiene

## Definition of Done for Wave 2

- All P0 tasks implemented with automated tests.
- Backend and frontend builds pass in CI.
- Production smoke suite passes after deployment.
- Release notes updated in docs for the wave.
