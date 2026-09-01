# Flarum Infrastructure Runbook

Date: 2026-08-31
Applies to: National Gear Exchange staging and production

## Outcome

Provision a private, supportable Flarum service on a dedicated Azure Linux VM. This runbook creates no PHW resources by itself; obtain a change window and follow the commands in a controlled operator terminal.

## Prerequisites

- Named National service owner and forum operator
- Approved domain, such as `community.projecthealingwaters.org`
- Azure subscription, resource group, network owner, and Key Vault owner
- Ubuntu LTS VM with private administrative access and current security updates
- Supported Flarum release, PHP version, database version, and extension lockfile recorded in the extension register
- Transactional SMTP account with SPF, DKIM, and DMARC prepared
- Off-box encrypted backup destination and an isolated restore VM

## Target Design

| Component | Pilot standard |
| --- | --- |
| Compute | One dedicated Ubuntu LTS Azure VM, sized after staging load test |
| Web tier | Nginx terminating TLS and PHP-FPM |
| Application | Composer-managed Flarum under a non-root service account |
| Database | MySQL 8.4 LTS or PostgreSQL LTS; choose one and record it before installation |
| Assets | Local filesystem for staging; object storage only after the chosen extension is staged and approved |
| Mail | Authenticated transactional SMTP over TLS |
| Background work | System scheduler invoking Flarum's scheduled task command at the selected interval |
| Secrets | Azure Key Vault or protected runtime environment file readable only by the service account |
| Observability | Azure Monitor/Log Analytics plus independent HTTPS uptime check |

Do not use the Alpine Events Windows App Service, its deployment package, or its Azure SQL schema as the Flarum host.

## Provisioning Steps

1. Create separate staging and production resource groups or equivalent isolation boundaries. Do not use production credentials in staging.
2. Create a VM subnet with inbound HTTPS only. Restrict SSH to approved administrator source ranges, preferably through Azure Bastion or just-in-time access.
3. Create a managed database with a dedicated Flarum database and least-privilege application user. Do not share the Alpine Events database credentials or schema.
4. Create a dedicated storage container/account for encrypted backups. Grant write access to the backup identity only and read access only to the restoration operator.
5. Install Nginx, PHP-FPM, PHP extensions required by the exact Flarum release, Composer, and the selected database client. Follow the official installation guide for version-specific requirements: <https://docs.flarum.org/install>.
6. Create a non-login `flarum` service account. The account owns Flarum application files and has write access only to the Flarum directories that require it, including `storage`, `assets`, and uploaded asset paths for the selected release.
7. Install Flarum with Composer under the service account. Commit the resulting `composer.json` and `composer.lock` to the separate Flarum infrastructure repository, not this Alpine Events repository, unless PHW intentionally centralizes that deployment code later.
8. Configure Nginx to serve Flarum's public directory only. Deny direct web access to configuration, vendor, storage, logs, backups, and Composer files. Enable HTTPS and HSTS after validating the final hostname.
9. Store database credentials, SMTP credentials, Flarum application secret, and identity-provider client secrets in Key Vault. Inject them at deployment/startup. Do not place them in `config.php`, source control, shell history, or evidence files.
10. Configure Flarum's base URL with the final HTTPS domain, SMTP, trusted proxy behavior if applicable, and production debug disabled.
11. Configure the scheduler under the service account. Verify it runs and does not overlap. Document the exact command and interval for the pinned Flarum release.
12. Configure daily encrypted backups, log retention, vulnerability patching, VM alerts, disk-space alerts, certificate-expiry alerts, database alerts, and external availability checks.

## Security Baseline

- Run the VM, web server, PHP-FPM, database connection, backups, and scheduler without root privileges where possible.
- Deny database public access unless a documented private networking exception exists.
- Disable PHP error display in production and retain logs only in protected storage.
- Use restrictive ownership and mode bits for runtime configuration and secrets.
- Keep OS, PHP, Composer packages, Flarum core, and extensions on a defined patch cadence.
- Do not install the Flarum Extension Manager for untrusted administrators. Composer changes are reviewed and deployed through the controlled process.
- Restrict Flarum administrators and moderators to National-approved personnel.
- Configure the forum private before importing any member data or enabling identity integration.

## Release and Upgrade Procedure

1. Record the target Flarum and extension versions in [flarum-extension-register.md](flarum-extension-register.md).
2. Take and verify database, uploads/assets, `storage`, `config.php`, `composer.json`, and `composer.lock` backups.
3. Apply the Composer update to staging first using the official Flarum update guidance: <https://docs.flarum.org/update>.
4. Run the release's database migration and cache-clear commands under the service account.
5. Verify private access, sign-in, member removal, tags, listing template, moderation, mail, attachments, scheduled jobs, and logs.
6. Obtain the National operator's approval before repeating the change in production.
7. If validation fails, restore the pre-change snapshot or roll back application files and lockfile together. Never attempt an unreviewed direct database repair.

## Health and Monitoring

Monitor at minimum:

- HTTPS availability and certificate validity
- VM CPU, memory, disk, and restart events
- Nginx 4xx/5xx rate and PHP-FPM failures
- database connection, storage capacity, backup completion, and restore age
- scheduler success/failure
- outbound-mail failure, bounce, and suppression rate
- identity login failure and denied-access rate, without logging tokens or raw claims

## Go-Live Gate

Do not expose the production forum until all of the following pass in staging:

1. HTTPS, privacy, and access controls are active.
2. A non-staff user cannot view the forum anonymously.
3. SMTP test mail and preference/unsubscribe behavior are verified.
4. Backup and isolated restore evidence exists.
5. The selected identity path passes [flarum-entra-integration-design.md](flarum-entra-integration-design.md).
6. Moderator, suspension, and read-only incident exercises pass.
7. No secret, token, member email, or production data is present in logs or documentation evidence.