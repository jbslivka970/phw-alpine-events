# Plan: Multi-Tenant Architecture Design (PHW Programs)

Convert the single-tenant PHW Colorado Alpine Events app into a multi-tenant SaaS supporting multiple PHW programs (Colorado Alpine, Montrose, …) with:
- Shared DB + `tenant_id` column on every domain row (with optional SQL Row-Level Security as defense-in-depth)
- Single domain; tenant is chosen post-login from the user's tenant memberships (no subdomains)
- One Entra External ID tenant for all programs; tenant membership lives in our app DB
- Users have one normal **home/program** tenant membership by default. They may also hold temporary auxiliary memberships such as a `Demo` tenant; admins may belong to multiple tenants and/or hold a `root` role above all tenants
- Per-tenant brand identity on outbound messaging (email/SMS sender, logos, colors, copy) and an admin scope limited to their tenant
- Rollout: incremental behind a `MULTI_TENANT_ENABLED` flag, all current data backfilled into a default "Colorado Alpine" tenant before a second tenant is onboarded

### Demo tenant requirement

Support a first-class `Demo` tenant that can be granted temporarily to users who already belong to a normal program tenant such as Colorado Alpine, Denver, Montrose, etc. Demo behaves like any other tenant for auth, routing, branding, and data isolation, but it is marked as sandbox/non-operational so it can be seeded, reset, excluded from production program metrics, and guarded against accidental real outbound communications. A user's Demo access is an additional membership; it must not move, clone, or weaken access to their home tenant data.

The Demo tenant requirement is only complete when it is operationally documented as a supported sandbox mode: root-owned reseed/reset flow, expiry handling for temporary memberships, analytics exclusion by default, and outbound notification suppression by default. Treat Demo as a first-class product requirement, not a loose fixture.

### Versioning rule for true multi-tenancy

Preparatory schema work, bootstrap updates, and behind-flag tenant plumbing can continue on the current major release line while Colorado Alpine remains the only live production tenant. The first production release that adds a real second tenant, exposes live tenant switching beyond Colorado Alpine-only behavior, or otherwise makes true multi-tenancy part of the supported external contract must ship as a major-version increment.

## Execution safety guardrails (non-negotiable)

1. **Do not break production**
    - No direct production schema changes, app-setting writes, slot swaps, deploy triggers, or data migrations until explicit release approval is given.
    - Multi-tenant implementation and validation work runs in local/dev/staging only; production checks during build are read-only health verification only.
    - Keep `MULTI_TENANT_ENABLED=false` in production until the staged rollout gates in Phase 8 are completed and signed off.
    - Before any approved production change window: require current backup/snapshot availability, explicit rollback command list, and operator confirmation.

2. **Do not trigger live alerts, email, or SMS during build/test**
    - Test and migration rehearsals must run in non-production environments with notification senders in safe mode (`stub`/test-only behavior).
    - Keep mutation-heavy smoke toggles off unless explicitly needed for a controlled test window: `SMS_SMOKE_ENABLED=0`, `SMS_COMPLIANCE_REQUIRED=0`, `E2E_ALLOW_TAVF_MUTATIONS=false`.
    - Disable outbound compliance webhooks during implementation validation by leaving `COMPLIANCE_ALERT_WEBHOOK_URL` unset in non-production execution contexts.
    - Retention and cleanup validations must be dry-run only during implementation (`RETENTION_DRY_RUN=true`, `RETENTION_CONFIRM_DELETE=false`).
    - If any controlled SMS test is required, restrict to `TEST_NOTIFICATION_SMS_ALLOWLIST` test numbers only and never target real production recipient lists.
    - Do not execute notification-producing smokes/e2e against production URLs during implementation unless explicitly approved for a scheduled release test.

## Implementation status (June 1, 2026)

### Completed slices in main

1. Tenant context and auth integration
    - `resolveTenantContext` middleware is active in auth success paths.
    - Backward compatibility path is preserved when `MULTI_TENANT_ENABLED=false`.
    - Header-based tenant selection and membership checks are active when enabled.

2. Member domain tenant scoping (compatibility-safe)
    - Member route/service operations pass and consume active tenant context.
    - Member CRUD enforces tenant scope when enabled.
    - New members receive a home tenant membership when created in enabled mode.

3. Core event endpoint tenant scoping (compatibility-safe)
    - `GET /api/events`, `GET /api/events/:id`, `POST /api/events`, `PUT /api/events/:id`, and `DELETE /api/events/:id` are tenant-scoped when enabled and schema supports `event.tenant_id`.
    - Runtime guard checks for `event.tenant_id` column existence to avoid breaking older schema states.

4. Extended event-id guard coverage (compatibility-safe)
    - Tenant access guard now protects event-id scoped downstream routes, including:
      - assignments and guest assignments
      - assignment recommendations
      - report exports (csv/txt/pdf)
      - lead summary email, report email alias, participation summary email
      - event AI draft generation

### Current behavior contract

1. With `MULTI_TENANT_ENABLED=false`
    - Existing users should observe no behavior change.
    - Default tenant behavior remains in place.

2. With `MULTI_TENANT_ENABLED=true`
    - Event and member access is constrained to the active tenant context.
    - Cross-tenant event-id access returns not found for guarded routes.

### Validation status snapshot

1. Backend typecheck has been run successfully after each tenant-guard increment.
2. Tenant resolver tests, member route tests, and event route tests include new tenant guard coverage and are currently passing.

### Resume point after testing

1. Continue guard pattern to remaining event-id dependent queries not yet explicitly checked by tenant access guard (if any emerge during QA).
2. Extend the same compatibility-safe guard style to other high-impact route families (`tavf`, `notifications`, `support`, `admin`) where event/member ids can be dereferenced.
3. Prepare a pre-release verification run focused on cross-tenant denial matrix before enabling `MULTI_TENANT_ENABLED` outside controlled environments.

---

## Phases

### Phase 1 — Tenant primitives (foundation)
1. Add `dbo.tenant` table: `tenant_id UNIQUEIDENTIFIER PK`, `slug`, `display_name`, `tenant_type (program/demo/system)`, `status (active/suspended/archived)`, `timezone`, `is_demo BIT`, `is_operational BIT`, `created_at`. Seed `Colorado Alpine` with a stable UUID stored as `DEFAULT_TENANT_ID`; seed `Demo` with a stable UUID stored as `DEMO_TENANT_ID`, `tenant_type = 'demo'`, `is_demo = 1`, and `is_operational = 0`.
2. Add `dbo.tenant_branding`: per-tenant `org_long_name`, `org_short_name`, `support_email`, `accessibility_email`, `logo_url`, `logo_dark_url`, `hero_image_urls (JSON)`, `primary_color`, `accent_color`, `dark_color`, `program_tagline`, `portal_login_url`, `mission_blurb`.
3. Add `dbo.tenant_messaging`: per-tenant `email_from`, `email_reply_to`, `email_bcc_monitor`, `sms_provider (acs/twilio/telnyx)`, `sms_from`, `twilio_messaging_service_sid`, `telnyx_messaging_profile_id`, `telnyx_from_number`. Secret values resolved from Key Vault references keyed by `tenant_id`, not stored in plaintext.
4. Add `dbo.tenant_membership (tenant_id, user_id, member_id NULL, role, membership_kind, home_tenant_id NULL, starts_at, expires_at NULL, status, created_by_user_id, created_at, revoked_at NULL)` as the canonical tenant access table. Use `membership_kind = 'home'` for a user's normal program tenant and `membership_kind = 'temporary_demo'` for Demo access. Add `is_root BIT` and `root_role` (root_admin / support) columns to `dbo.[user]`. If a separate `dbo.tenant_admin` join is kept for compatibility, make it a narrow admin-specific view or migration bridge over `tenant_membership` rather than a competing source of truth.
5. Add reusable migration helpers (idempotent schema patches following the existing `IF NOT EXISTS` pattern in `database/schema.sql`).

### Phase 2 — tenant_id on every domain row
6. Add nullable `tenant_id UNIQUEIDENTIFIER` to: `member`, `[group]`, `member_group`, `member_persona`, `event`, `event_response`, `event_assignment`, `event_notification_target`, `waitlist_promotion_offer`, `notification_template`, `notification_template_version`, `notification_log`, `sms_consent_log`, `email_preference_log`, `inbound_sms_log`, `import_log`, `member_identity_link`, `identity_invite_claim`, `identity_invite_trace`, `tavf_posting`, `tavf_application`, `tavf_match`, `support_email_relay_config`, `support_inbound_email_log`, `rsvp_short_link`. *(Parallel migration; one ALTER per table.)*
7. Backfill all existing rows with `DEFAULT_TENANT_ID` ("Colorado Alpine"). *(Depends on step 6.)*
8. Add FK to `dbo.tenant`, then enforce `NOT NULL` on `tenant_id`. *(Depends on step 7.)*
9. Add covering indexes prefixed with `tenant_id` on hot lookup paths: `(tenant_id, member_id)`, `(tenant_id, event_id)`, `(tenant_id, event_date)`, `(tenant_id, status)` on tavf tables, `(tenant_id, channel, template_name)` on `notification_template`.
10. Replace the `UNIQUE(email)` on `dbo.member` with `UNIQUE(tenant_id, email)` so the same person can register in two programs as separate member rows. Same for `member.mobile_phone`, `notification_template.template_name`, `[group].group_name`. For Demo, create or link a Demo-scoped member row when member-level behavior is needed; never reuse the home tenant's `member_id` across tenants.

### Phase 3 — Tenant resolution + auth (server side)
11. Introduce `resolveTenantContext` middleware after `authenticate`: derives `req.tenantId` from (a) `X-Tenant-Id` header set by frontend after tenant selection, or (b) the only active non-expired tenant membership the user has, or (c) the JWT-bound `tenantId` cookie issued at tenant selection time. Reject if user is not a root admin and the requested `tenant_id` is not in their active `tenant_membership` set, including `starts_at <= now` and `(expires_at IS NULL OR expires_at > now)`. Demo is accepted only through an explicit active Demo membership.
12. Add `req.user.roleByTenant: Map<tenantId, role>`, `req.user.membershipByTenant`, and a `root` flag. Refactor `backend/src/middleware/rbac.ts` so `requireAdmin`, `requireEventCreator`, `requireTavfCreator` check the role against `req.tenantId` (root admins always pass). RBAC must treat expired or revoked temporary Demo memberships as absent.
13. Update `backend/src/middleware/auth.ts` member-link logic to resolve identities per-tenant: `member_identity_link` lookups become `(tenant_id, entra_object_id)` and `(tenant_id, email)`. The invite-claim flow already produces a token; extend it to encode `tenant_id` so a claim deterministically lands in the right tenant.
14. Replace `AUTH_BOOTSTRAP_ADMIN_EMAILS` (single list) with `AUTH_BOOTSTRAP_ROOT_ADMIN_EMAILS` (root) plus per-tenant bootstrap rows seeded from `dbo.tenant_membership`. Update `adminBootstrapService.ts` accordingly.

### Phase 4 — Tenant-aware data access
15. Add a thin repository wrapper `forTenant(tenantId)` exposing helpers (`db.tenant.member.findById`, etc.) that automatically inject `AND tenant_id = @tenantId` into every query. Migrate every service file (memberService, rsvpService, eventService, tavfService, groupService, personaService, csvImportService, notificationService, identityProvisioningService, identityInviteClaimService, rsvpLinkService, emailPreferenceLinkService, …) to use it.
16. Add ESLint rule or CI grep guard that fails if a `*.ts` file under `backend/src/services` or `backend/src/routes` issues raw SQL without referencing `tenant_id` (allow-list the few tenant-management services).
17. Apply SQL Server **Row-Level Security** policies as defense-in-depth: a `SESSION_CONTEXT('tenant_id')` security predicate on each tenant-scoped table. Wrapper sets it per request. Root admins bypass via a `root_bypass` predicate. *(Optional but strongly recommended; can ship after step 15.)*
18. Update background jobs (`reminderJob.ts`, `waitlistLifecycleJob.ts`, `retentionJob.ts`, TAVF expiry) to iterate tenants and process each in its own scope, so per-tenant outages don't poison other tenants' jobs.

### Phase 5 — Per-tenant branding & messaging
19. Move all hardcoded brand strings out of `backend/src/templates/*` into template variables sourced from `dbo.tenant_branding`. Update `renderTemplate()` to inject `{{org.shortName}}`, `{{org.longName}}`, `{{org.primaryColor}}`, `{{org.logoUrl}}`, `{{org.supportEmail}}`, `{{org.portalLoginUrl}}`, `{{org.tagline}}`. Audit list to fix:
    - `eventInvite.ts`, `eventCancellation.ts`, `eventThankYou.ts`, `eventUpdate.ts`, `eventReminder.ts`, `rsvpConfirmation.ts`, `rsvpWaitlisted.ts`, `waitlistPromotion.ts`, `assignmentConfirmation.ts`, `assignmentAdminAdded.ts`
    - Inline strings in `backend/src/services/notifications.ts` (lines ~432, ~1537, ~1961, ~2228, ~2323, ~2365, ~2447, ~2545)
    - `backend/src/routes/sms.ts` — 15+ `"PHW Alpine:"` prefixes
    - `backend/src/services/aiInviteService.ts`
    - `backend/src/routes/admin.ts` — `DEFAULT_PORTAL_LOGIN_URL`
    - `backend/src/routes/events.ts` — iCal `PRODID` and PDF title
20. Replace single-sender Email/SMS construction in `backend/src/services/notifications.ts` with a `getMessagingForTenant(tenantId)` factory that returns the right `AcsEmailService`/`AcsSmsService`/`TwilioSmsService`/`TelnyxSmsService` configured from `dbo.tenant_messaging`. Cache instances per tenant.
21. Per-tenant unsubscribe routing: include `tenant_id` (or short `tenant_slug`) in unsubscribe and RSVP short-link tokens; `emailPreferenceLinkService.ts` and `rsvpLinkService.ts` load/write logs scoped to the resolving tenant.
22. SMS STOP/HELP compliance per-sender: inbound webhook in `backend/src/routes/sms.ts` resolves tenant from the *destination* phone number (the `To` field), then writes consent rows scoped to that tenant. Reply text uses that tenant's `org_short_name`.
23. Notification templates become tenant-scoped (`(tenant_id, template_name)` unique). Add inheritance: if a tenant row is missing, fall back to a `tenant_id = NULL` "global default" row owned by root. Template editor UI exposes "Customize for my tenant" which copies the global row.

### Phase 6 — Frontend (single domain, post-login tenant switch)
24. New tenant-context API: `GET /api/v1/me/tenants` returns `[{tenant_id, slug, display_name, tenant_type, is_demo, role, membership_kind, expires_at, branding}]` for the signed-in user. Frontend stores active `tenant_id` in localStorage and forwards it as `X-Tenant-Id` header from `frontend/src/api/client.ts` (sibling to the existing `X-Member-Invite-Token`).
25. New `<TenantProvider>` React context wrapping the app (after MSAL). On login: if user has 1 active tenant → auto-select; if >1 → show a `TenantPicker` page; if 0 → show "no access" state with support contact. Demo memberships appear with a clear Demo label and expiry date, and the app should default back to the user's home tenant when a saved Demo selection has expired. Root admins see an additional "Operate as: root / Colorado Alpine / Denver / Demo" switcher in the header, persisting their chosen scope.
26. Drive all branding from the active tenant: replace hardcoded strings in `frontend/src/components/Layout.tsx` (titles, footer org name, accessibility email, logo paths) and `frontend/src/pages/LoginPage.tsx` (hero photos, tagline, logo, description) with values from `tenant.branding`. Login page is generic until tenant is chosen; per-tenant hero shows after selection.
27. Add `frontend/public/branding/<tenant_slug>/` asset convention; tenant rows store relative paths. Existing PHW Alpine assets move to `branding/colorado-alpine/`.
28. Tenant-scoped admin nav: hide cross-tenant admin items from non-root admins. Add a `/root` admin section visible only to `is_root` users (tenant CRUD, branding defaults, suspend/reactivate, cross-tenant analytics).

### Phase 7 — Root admin surfaces
29. Root-admin REST surface (under `/api/v1/root/`):
    - `POST /tenants` — create tenant
    - `PATCH /tenants/:id` — update metadata
    - `POST /tenants/:id/admins` — grant tenant admin
    - `DELETE /tenants/:id/admins/:userId` — revoke tenant admin
    - `POST /tenants/:id/memberships` — grant tenant access, including temporary Demo access with `expires_at`
    - `PATCH /tenants/:id/memberships/:membershipId` — extend, revoke, or change role for a membership
    - `POST /tenants/:id/branding` — upsert branding
    - `POST /tenants/:id/messaging` — upsert messaging config
    - `POST /tenants/:id/suspend` — suspend/reactivate
    - `GET /tenants/:id/usage` — per-tenant usage metrics

    All guarded by a new `requireRoot` middleware independent of any tenant context.
30. Tenant provisioning workflow: creating a tenant clones the seed `notification_template` set, seeds the four system groups (ALL, ADMIN, VOLUNTEERS, PARTICIPANTS) for that tenant, sets up an empty branding/messaging row that the root admin must fill before the tenant is marked `active`. Demo provisioning additionally seeds synthetic demo events/members/groups, marks outbound messaging as sandbox/suppressed by default, and exposes a root-only reset/reseed action.
31. Cross-tenant analytics endpoints (root only) aggregate by `tenant_id`: members, events, RSVPs, send volume, opt-out rates, error rates.

### Phase 8 — Rollout, migration, and cleanup
32. Introduce `MULTI_TENANT_ENABLED` env flag. When `false`: backend ignores tenant context (assumes `DEFAULT_TENANT_ID`), frontend hides tenant switcher and pickers. When `true`: full tenant resolution active.
32a. Add release preflight gate: verify safety guardrails are active (`MULTI_TENANT_ENABLED=false` in production until sign-off, non-prod notification safety settings, dry-run retention settings, production change rollback plan documented).
33. Run schema migrations (Phases 1+2) in production with the flag **off**. Backfill `tenant_id` on every existing row to `DEFAULT_TENANT_ID`. Validate row counts and FKs.
34. Flip `MULTI_TENANT_ENABLED=true` in a staging slot; run the full E2E matrix scoped to the default tenant (parity check with single-tenant behavior).
35. Promote to production via blue/green slot swap. Existing PHW Colorado Alpine continues as the default tenant; nothing visible changes for current members.
36. Onboard and validate `Demo` first as the first non-default tenant: create tenant → seed synthetic content → grant temporary Demo memberships to selected real users → verify they can switch between home tenant and Demo without data bleed → verify expired Demo access disappears. Then onboard the first real second tenant ("Montrose" or "Denver") via the root admin UI: create tenant → upload branding/logo → configure messaging (provision SMTP `From` and Twilio Messaging Service SID via Key Vault) → seed admins → import members.
37. Remove `MULTI_TENANT_ENABLED` once a second tenant has been live for a stabilization period; multi-tenant becomes the only mode.
38. When Step 36 expands from Demo validation into a live second tenant rollout, cut a major release tag and release notes that explicitly announce the supported true multi-tenant contract change.

---

## Files to touch

### Schema
- `database/schema.sql` — add `tenant`, `tenant_branding`, `tenant_messaging`, `tenant_membership` (plus optional `tenant_admin` compatibility view/bridge); add `tenant_id` to all domain tables; replace single-column unique constraints; add covering indexes; optional RLS policies.

### Backend — auth & RBAC
- `backend/src/middleware/auth.ts` — tenant-aware identity link, set `req.tenantId`, set SQL `SESSION_CONTEXT`.
- `backend/src/middleware/authRoleResolver.ts` — resolve `roleByTenant`, membership metadata, and `is_root` from `dbo.tenant_membership` + `dbo.[user]`.
- `backend/src/middleware/rbac.ts` — every guard becomes tenant-scoped; root bypass.
- `backend/src/services/adminBootstrapService.ts` — seed root admins from `AUTH_BOOTSTRAP_ROOT_ADMIN_EMAILS`; per-tenant bootstrap from config table.
- `backend/src/services/identityInviteClaimService.ts` — encode `tenant_id` in the claim so onboarding lands in the correct tenant.
- **New:** `backend/src/middleware/resolveTenantContext.ts`
- **New:** `backend/src/middleware/requireRoot.ts`

### Backend — data access (every service must add tenant filter)
- `backend/src/services/memberService.ts`, `rsvpService.ts`, `groupService.ts`, `personaService.ts`, `tavfService.ts`, `csvImportService.ts`, `rsvpLinkService.ts`, `emailPreferenceLinkService.ts`, `identityProvisioningService.ts`
- All route handlers: `backend/src/routes/events.ts`, `members.ts`, `rsvp.ts`, `tavf.ts`, `groups.ts`, `admin.ts`, `import.ts`, `templates.ts`, `sms.ts`, `preferences.ts`, `support.ts`, `reports.ts`, `calendar.ts`, `publicRsvp.ts`
- **New:** `backend/src/routes/root.ts` — tenant CRUD / membership grants / Demo reset / branding / messaging / analytics
- **New:** `backend/src/services/tenantService.ts`, `tenantMembershipService.ts`, `tenantBrandingService.ts`, `tenantMessagingService.ts`

### Backend — notifications & branding
- `backend/src/services/notifications.ts` — `getMessagingForTenant(tenantId)` factory; per-tenant ACS/Twilio/Telnyx clients; tenant-aware unsubscribe footer.
- `backend/src/templates/*` — extract every hardcoded "PHW Alpine" / "Colorado Alpine" / color / footer to template variables.
- `backend/src/services/aiInviteService.ts` — tenant-aware copy; replace literal mission strings.
- `backend/src/routes/sms.ts` — resolve tenant from inbound `To` number; tenant-aware reply prefix and STOP/HELP.
- `backend/src/routes/events.ts` — iCal `PRODID` and PDF title from tenant branding.

### Backend — jobs
- `backend/src/jobs/reminderJob.ts`, `waitlistLifecycleJob.ts`, `retentionJob.ts` — iterate tenants; isolate failures per tenant.

### Frontend
- `frontend/src/authConfig.ts` — single Entra config (no per-tenant client IDs needed).
- `frontend/src/api/client.ts` — forward `X-Tenant-Id` header.
- `frontend/src/api/baseUrl.ts` — unchanged (single domain).
- `frontend/src/components/Layout.tsx` — branding from active tenant.
- `frontend/src/pages/LoginPage.tsx` — generic pre-tenant; per-tenant hero after selection.
- **New:** `frontend/src/contexts/TenantContext.tsx`
- **New:** `frontend/src/pages/TenantPickerPage.tsx` — includes Demo badge/expiry and prevents stale expired Demo selections.
- **New:** `frontend/public/branding/<tenant_slug>/` asset convention (move existing assets to `branding/colorado-alpine/`)
- **New:** `frontend/src/pages/root/` — root-admin tenant management pages

### CI/CD & infra
- `.github/workflows/ci-cd.yml` — seed a second test tenant plus Demo; tenant matrix on E2E suites; cross-tenant denial and temporary-Demo-expiry tests in `e2e_api_role_matrix`.
- `deploy/azuredeploy.json` — Key Vault references for per-tenant messaging secrets; naming convention: `tenant-<slug>-twilio-auth-token`, `tenant-<slug>-acs-connection-string`, etc.

---

## Verification checklist

0. **Safety preflight (before any migration or rollout action):** confirm target environment, confirm no live notification/alert side-effects are enabled for the run, and confirm rollback artifacts are available.
1. **Unit:** `tenantService.spec.ts` covers tenant CRUD + admin grants; `forTenant` repository wrapper tests prove every helper injects `tenant_id`. Negative test: a manually-constructed query without `tenant_id` is caught by the CI lint/grep guard.
2. **Integration (backend):** seed two tenants in test DB; assert `GET /events` as tenant-A admin **never** returns tenant-B events; assert root admin can list across both via `/root`.
3. **Identity:** invite-claim flow end-to-end — invite a member into tenant B, complete sign-in, confirm `member_identity_link.tenant_id = B` and that the user is invisible to tenant-A admins.
4. **Demo membership:** seed a user with Colorado Alpine `home` membership plus temporary Demo membership. Assert both tenants appear in `GET /me/tenants`; selecting Demo scopes every list/read/write to Demo only; selecting Colorado Alpine returns home data only; after `expires_at`, Demo disappears and direct `X-Tenant-Id: Demo` requests return `403`.
5. **RLS (if enabled):** force a query without `SESSION_CONTEXT('tenant_id')` set and confirm zero rows return on tenant-scoped tables.
6. **Notifications:** for each tenant, verify (a) outbound email `From` matches `tenant_messaging.email_from`, (b) outbound SMS uses the tenant's Messaging Service SID, (c) inbound STOP to tenant-A's number opts the member out for tenant A only, (d) unsubscribe link in a tenant-B email writes to `email_preference_log` with `tenant_id = B`. For Demo, verify outbound communications are sandbox/suppressed unless explicitly enabled by root.
7. **Branding:** snapshot tests for each rendered email template under two different `tenant_branding` rows plus Demo; visual check of frontend Layout/Login under each tenant context.
8. **Migration parity:** before flipping `MULTI_TENANT_ENABLED`, diff member count, event count, and last-30-days `notification_log` totals before vs after backfill — all rows must have `tenant_id = DEFAULT_TENANT_ID` and totals must match exactly.
9. **CI E2E matrix:** `e2e_api_role_matrix` runs once per seeded tenant; include a cross-tenant denial case asserting tenant-A's admin token gets `403` on tenant-B resources and a Demo case asserting temporary membership grants only Demo access.
10. **Smoke after rollout:** existing `deploy_backend_smoke` and `deploy_frontend_smoke` continue passing scoped to the default tenant; add a Demo smoke run, then a second smoke run scoped to the new real tenant once it exists.
11. **Rollback:** confirm migrations are reversible — documented script to drop `tenant_id` columns from a backup snapshot if a critical issue is found before the second tenant launches.

---

## Decisions (locked)

| Decision | Choice |
|---|---|
| Data isolation | Shared DB, `tenant_id` on every row. SQL Server Row-Level Security added as defense-in-depth but `forTenant` application-level filtering is the primary boundary. |
| URL routing | Single domain. Tenant resolved post-login from DB memberships, carried as `X-Tenant-Id` header. No subdomains, no path prefixes. |
| Identity provider | One Entra External ID tenant for all PHW programs. Tenant membership is purely an app-DB concept. |
| User-to-tenant cardinality | Users have one normal home/program membership by default, may hold temporary auxiliary memberships such as Demo, and admins may belong to multiple tenants and/or hold a `root` role above all tenants. Member rows remain tenant-scoped and are never shared across tenants. |
| Demo tenant | Demo is a real tenant for isolation and switching, but flagged as `tenant_type = demo`, `is_demo = 1`, `is_operational = 0`; access is granted through expiring `temporary_demo` memberships. |
| Rollout | Incremental behind `MULTI_TENANT_ENABLED`. Backfill all current data into the default Colorado Alpine tenant first; second tenant onboarded only after the flag has been live and stable. |

### Out of scope for v1
- Per-tenant subdomains or wildcard certs
- Per-tenant Entra app registrations
- Per-tenant database or schema isolation
- Cross-tenant data sharing (shared events or members between programs). Demo grants shared user access, not shared tenant data.
- Billing / metering / SaaS commerce
- White-label custom domains for tenants

---

## Risks (ranked)

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Cross-tenant data leakage** from a missing `tenant_id` filter — highest impact risk | Every read/write through `forTenant` wrapper; CI grep-guard against raw SQL missing `tenant_id`; RLS as belt-and-suspenders; integration tests seed two tenants and assert isolation on every list endpoint. |
| 2 | **Auth boundary error** elevating a tenant admin to root | `is_root` lives on `dbo.[user]` only, never on a JWT claim; `requireRoot` reads it from DB on each request; root scope is never inferred from token roles. |
| 3 | **Member identity collision** — same Entra account could match member rows in two tenants | `member_identity_link` keyed by `(tenant_id, entra_object_id)`; invite-claim token carries target `tenant_id` so first sign-in lands deterministically; UI shows tenant picker in the rare case a person is in two tenants. |
| 4 | **Notification cross-talk** — tenant-B email sent from tenant-A `From` address | `getMessagingForTenant(tenantId)` is the only path to a sender; templates resolve branding strictly from `req.tenantId`; unit tests assert `From` matches tenant. |
| 5 | **SMS STOP/HELP miswiring** — consent must route per sender number | Inbound webhook resolves tenant from the `To` number; `sms_consent_log` carries `tenant_id`; per-tenant STOP keyword tests. |
| 6 | **Migration risk under load** on large tables (esp. `notification_log`) | Three-step: nullable add → batch backfill → NOT NULL constraint; run in a maintenance window; row-count validation and tested rollback script. |
| 7 | **Background jobs leaking failures across tenants** | Per-tenant `try/catch` isolation per iteration; job runner logs `tenant_id` on each cycle. |
| 8 | **Cost & ops per tenant** — each needs Twilio number, SMTP domain (SPF/DKIM), Key Vault secrets | Standardize a tenant-onboarding checklist; root-admin UI captures these values; Key Vault references rather than env vars. |
| 9 | **Observability regression** — logs/metrics without `tenant_id` leave root admins blind | Add `tenant_id` to every structured log line and as an App Insights custom dimension; per-tenant dashboards. |
| 10 | **Test debt** — existing E2E and smoke jobs assume single-tenant | Seed a second test tenant in fixtures early in Phase 1 so test suite evolves in parallel with implementation. |
| 11 | **Stale reminders to suspended tenants** | Jobs filter `WHERE tenant.status = 'active'` at the top of each per-tenant loop. |
| 12 | **Splash site coupling** — `splash/` is hardcoded to `phwcoloradoalpine.org` | Treat as a separate property; defer multi-tenant marketing pages to a later wave. |
| 13 | **Demo contamination** — Demo data, metrics, or notifications could be confused with real program activity | `tenant_type = demo`, `is_operational = 0`, analytics exclude Demo by default, outbound messaging suppressed by default, and reset/reseed is root-only with audit logging. |
| 14 | **Temporary access lingering too long** | `expires_at` required for `temporary_demo` memberships, nightly cleanup/revocation job, UI expiry display, and API rejects expired memberships even if the frontend has stale localStorage. |
