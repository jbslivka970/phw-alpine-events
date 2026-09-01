# Flarum National Gear Exchange Build Backlog

Date: 2026-08-31
Status: Planning baseline. No Flarum infrastructure or integration is deployed.

Complete work packages in order. A failed acceptance criterion stops progression to the next package until the issue is resolved or the decision is changed.

| ID | Work package | Owner role | Dependencies | Acceptance criteria | Rollback |
| --- | --- | --- | --- | --- | --- |
| FGE-01 | National governance | National sponsor and operations owner | None | Named service owner, moderator lead, security contact, privacy contact, retention decision, acceptable-use rules, and pilot programs recorded | Do not provision the service |
| FGE-02 | Separate service repository and CI/CD | Repository administrator and release engineer | FGE-01 | Dedicated Gear Exchange repository, protected branches, staging/production environments, independent deployment identities, and forum-only workflow skeleton are ready | Remove repository environments and unused identities |
| FGE-03 | Azure foundation | Azure administrator | FGE-02 | Dedicated staging VM, least-privilege identities, network rules, Key Vault access, DNS plan, backup destination, and monitoring are ready | Delete staging resources and credentials |
| FGE-04 | Flarum staging baseline | Forum operator | FGE-03 | Exact Flarum/PHP/database versions installed from the runbook; HTTPS, SMTP test mail, scheduled job, storage, and health monitoring pass | Destroy staging VM; retain no member data |
| FGE-05 | Extension review | Security reviewer and forum operator | FGE-04 | Core capability gaps recorded; each candidate extension passes compatibility, maintenance, permissions, and disable/uninstall testing | Remove candidate extensions and restore baseline |
| FGE-06 | Identity Path A spike | Application engineer | FGE-04, FGE-05 | Pinned community OIDC extension passes the full identity matrix without relying on email-only association or browser assertions | Disable extension, revoke client secret, purge test accounts |
| FGE-07 | Identity go/no-go | Security reviewer and National owner | FGE-06 | Written decision: accept Path A or authorize Path B. No ambiguous conditional launch | Keep staging closed |
| FGE-08 | Identity Path B, if required | Application engineer | FGE-07 | PHW-owned extension passes security review, tests, and full identity matrix | Disable/remove extension; revoke credentials |
| FGE-09 | Forum taxonomy and templates | Moderator lead | FGE-05, FGE-07 | Tags, permissions, listing template, lifecycle, notices, and moderation queue match the information architecture | Reset staging content/configuration |
| FGE-10 | Moderation readiness | Moderator lead | FGE-09 | Moderators complete training; approval, flag, suspension, appeal, and escalation exercises pass | Remove staff privileges and close forum |
| FGE-11 | Backup and recovery | Forum operator | FGE-04 | Encrypted database/assets/configuration backup restores to isolated staging with verified records and uploads | Rebuild isolated target from known-good backup |
| FGE-12 | PHW application links | Application engineer | FGE-07 | National/app links, direct-login behavior, logout, denied state, and accessibility checks pass without exposing tokens | Disable navigation link/feature flag |
| FGE-13 | Security and accessibility validation | Security and accessibility reviewers | FGE-08 or FGE-06, FGE-09 | Threat-model actions, dependency scan, permission tests, keyboard and screen-reader paths, mobile layouts, and audit logging review pass | Keep forum closed and remediate |
| FGE-14 | Closed pilot | National owner | FGE-10 to FGE-13 | 30-45 day pilot includes 2-3 programs and a non-Colorado program; metrics and incidents are recorded | Set forum read-only; preserve evidence |
| FGE-15 | National rollout decision | National governance body | FGE-14 | Signed readiness evidence shows identity removal, restore, moderator staffing, privacy, and policy gates pass | Remain pilot-only or read-only |

## Required Artifacts

- Completed [flarum-pilot-readiness-evidence-template.md](flarum-pilot-readiness-evidence-template.md)
- Approved [flarum-extension-register.md](flarum-extension-register.md)
- Current [flarum-infrastructure-runbook.md](flarum-infrastructure-runbook.md)
- Current [flarum-backup-recovery-portability-runbook.md](flarum-backup-recovery-portability-runbook.md)
- Deployment separation defined in [flarum-deployment-boundary.md](flarum-deployment-boundary.md)
- Identity decision recorded in [flarum-entra-integration-design.md](flarum-entra-integration-design.md)
- Moderator roster and completed training records from [exchange-moderation-handbook.md](exchange-moderation-handbook.md)

## Delivery Rules

1. Do not combine identity, schema, extensions, and production access in a single rollout.
2. Run new or upgraded extensions in staging before production.
3. Keep each configuration change reversible and record its owner, timestamp, and verification result.
4. Use synthetic test identities and forum content for staging validation.
5. No live PHW SMS notifications are part of the forum. Forum email is validated independently through the Flarum SMTP configuration.
6. No production launch without a successful restoration exercise and removal-of-access test.