# Flarum Backup, Recovery, and Portability Runbook

Date: 2026-08-31

## Objective

Recover the National Gear Exchange from a known-good state and retain a complete, usable data package if PHW later changes hosting or platforms.

## Backup Set

Create an encrypted, off-box backup set that contains:

- Database dump from the selected database engine
- Forum-upload and public asset directories
- `storage` directory needed by the pinned Flarum release
- Runtime configuration, redacted of secrets when stored with documentation
- Secret reference names and recovery instructions, not secret values
- `composer.json` and `composer.lock`
- Nginx/site configuration and scheduler configuration
- Exact Flarum, PHP, database, operating system, and extension versions

Back up daily at minimum. Retain at least 30 days until National records-retention policy specifies a longer period. Encrypt backups at rest and in transit. Store restoration keys separately from the backup destination.

## Backup Verification

1. Check job completion, size, checksum, encryption, off-box destination, and retention policy every day.
2. Alert the forum operator on missing, failed, or unexpectedly small backups.
3. Do not treat a successful upload as proof of recovery. Complete an isolated restore before pilot and quarterly thereafter.

## Isolated Restore Procedure

1. Create an isolated staging VM/network with no public DNS and no outbound forum email enabled.
2. Install the exact supported OS, PHP, Flarum, and extension versions from the backup lockfile.
3. Restore the database into a new database name and restore assets/storage with appropriate ownership.
4. Restore configuration using staging secrets and staging hostname only.
5. Run only the documented migration/cache-clearing commands required by the pinned Flarum release.
6. Verify forum startup, private access, test user sign-in, tags, permissions, discussions, posts, attachments, flags, moderator data, and scheduled jobs.
7. Record timestamps, backup identifier, validator, result, defects, and remediation in the readiness evidence file.
8. Destroy or sanitize the isolated restore environment after the evidence and any required retained logs are secured.

## Recovery Scenarios

| Event | First response | Recovery |
| --- | --- | --- |
| Application or extension regression | Set forum read-only; preserve logs | Restore prior application/lockfile and test before reopening |
| Database corruption | Stop writes and preserve evidence | Restore latest known-good database/assets pair to recovery target |
| VM compromise | Isolate VM and rotate all credentials | Rebuild clean VM, restore verified backup, complete incident review |
| Storage loss | Set forum read-only | Restore assets and verify attachment integrity |
| Entra outage or identity defect | Disable login integration or set read-only | Use emergency-admin process, remediate in staging, rerun matrix |
| SMTP failure | Stop invitations/bulk notifications | Fix provider/DNS/credentials and send controlled test mail |

## Account Export and Deletion

Handle export and deletion requests through the National privacy owner. Preserve only records legally required for security, moderation, or audit purposes. Record the request, decision, scope, approval, execution, and completion without placing sensitive exports in this repository.

Before deletion, determine whether forum content should be anonymized, retained, or deleted under the approved National policy. Do not promise deletion behavior that Flarum core or a selected extension cannot perform and verify.

## Portability

Flarum has no assumed turnkey migration to another forum product. Maintain database, asset, configuration, and versioned dependency backups so PHW can evaluate a future importer or mapping project. A move to Discourse, NodeBB, or a hosted provider requires a discovery phase to map users, discussions, posts, tags, permissions, uploads, and private data.

Use the final National hostname from the pilot. This preserves user-facing URLs during a future hosting cutover even though data migration remains a separate project.