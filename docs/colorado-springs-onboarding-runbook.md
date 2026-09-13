# Colorado Springs Tenant Onboarding and Capacity Runbook

Status: prepared, not yet approved for production execution.

## Known Baseline (September 13, 2026)

- App Service plan: `phw-alpine-splash-plan`, Linux `B1`, one worker. Backend, frontend, and splash apps share this plan.
- Seven-day plan peak: CPU `100%`, memory `89%`.
- Backend seven-day peak hourly average response time: `13.55s`; observed HTTP 5xx total: `54`.
- Azure SQL: `phwalpinedb`, `Basic`, 5 DTUs, 2 GB maximum. Seven-day peak DTU: `61%`; storage: `2%`.
- Colorado Springs is expected to add roughly 10 times the current total data volume.

The current capacity is not an acceptable onboarding baseline. Start with App Service `P0v3` x 1 and Azure SQL `S2` with a 20 GB cap. Re-evaluate after the rehearsal import; scale horizontally or move SQL higher only from measured saturation.

## Required Inputs

- Approved production change window and rollback owner.
- Initial Colorado Springs administrator email and display name.
- Final organization long/short names, support/accessibility addresses, logo assets, and brand colors.
- Email sender/domain decision and SMS provider/number decision.
- Source member count, event history count, CSV size, duplicate-email count, and expected peak concurrent users.

## Capacity Change

1. Confirm an Azure SQL restore point/export and application rollback owner.
2. Preview the exact target and current subscription:

   ```bash
   bash scripts/scale-production-capacity.sh
   ```

3. During the approved window, apply the initial target:

   ```bash
   PRODUCTION_CHANGE_APPROVED=1 bash scripts/scale-production-capacity.sh --apply
   ```

4. Validate `/api/v1/health`, `/api/v1/health/startup`, login, tenant selection, member search, event list, and one non-sending notification preview.
5. Watch App Service CPU/memory/response time and SQL DTU for at least one normal peak period.

Rollback capacity commands:

```bash
PRODUCTION_CHANGE_APPROVED=1 bash scripts/scale-production-capacity.sh \
  --app-sku B1 --sql-objective Basic --sql-max-size 2GB --apply
```

Capacity rollback does not roll back data. Use Azure SQL point-in-time restore for an import/data failure.

## Tenant Provisioning

Create the tenant as suspended so it cannot be used before validation:

```json
{
  "slug": "colorado-springs",
  "display_name": "Colorado Springs",
  "tenant_type": "program",
  "status": "suspended",
  "timezone": "America/Denver",
  "is_demo": false,
  "is_operational": true
}
```

Use Root Administration to create it, then grant the designated administrator. Tenant creation now atomically creates branding, messaging, and the `ALL`, `ADMIN`, `VOLUNTEERS`, and `PARTICIPANTS` system groups.

Configure branding and messaging while the tenant remains suspended. Keep real outbound email/SMS disabled until sender ownership, consent language, opt-out behavior, and allowlists are verified.

## Import Rehearsal

1. Export and retain source row counts and a SHA-256 hash of each input file.
2. Rehearse against staging with a production-shaped data set.
3. Split large member imports into 500-1,000 row files. The upload cap is 5 MB, preview sessions are in-memory and expire after 30 minutes, and commit currently uses one transaction with per-row writes.
4. Do not run concurrent imports or deploy/restart the backend while a preview is awaiting commit.
5. Review shared-household emails and same-name/email conflicts. Never auto-resolve conflict rows without the program owner.
6. Confirm imported totals, active/inactive counts, personas, system-group assignments, opt-outs, and phone normalization.
7. Verify a Colorado Springs admin cannot read Colorado Alpine members/events and vice versa. Run the tenant denial matrix before activation.

## Scale Edge Cases and Gates

- Group administration previously loaded only 500 members. Do not use the existing full-member dropdown as the acceptance proof for a larger roster; verify member search and group assignment with records beyond row 500.
- CSV preview is tenant-scoped and now loads the tenant roster once. Commit is still row-oriented; time and observe a 1,000-row rehearsal before setting the production batch size.
- Member search uses wildcard matching and tenant-membership existence checks. Record p50/p95 latency for empty search and representative name/email searches.
- Notification fan-out can multiply by roster size. Keep live sends disabled during rehearsal and validate provider quotas, suppression, retry behavior, and per-tenant sender configuration.
- Retention defaults allow up to 50,000 deletions per target. Keep dry-run enabled through onboarding and review projected deletion counts after import.
- The database is shared. Verify every report, event, group, TAVF, preference, and notification-log sample with forced cross-tenant IDs before activation.

## Activation Gate

Reactivate Colorado Springs only after all of the following are recorded:

- Initial admin can sign in, select Colorado Springs, sign out, and recover from an expired session without clearing browser storage.
- Imported and source counts reconcile; no unresolved identity conflicts remain.
- Cross-tenant denial tests pass for non-root personas.
- p95 authenticated API latency is below 1 second during rehearsal and no sustained App Service CPU, memory, or SQL DTU metric exceeds 70%.
- Email/SMS sender configuration and compliance review are approved.
- Backup, rollback, monitoring, and support owners acknowledge the launch window.