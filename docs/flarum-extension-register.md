# Flarum Extension Register

Date: 2026-08-31
Status: No extension is approved for production yet.

## Policy

Flarum core capabilities are preferred. A community extension may be used only after its exact Composer package and version have been tested against the exact selected Flarum release in staging. Record the evidence, owner, permissions, stored data, removal procedure, and replacement path below before production installation.

Never use an extension solely because it was recommended in an old blog post, forum thread, or Composer search result. Community extensions carry lifecycle risk and are not Flarum Foundation support commitments.

## Core Capability Baseline

| Capability | Standard | Status |
| --- | --- | --- |
| Tags and scoped permissions | Flarum core | Required |
| Flags/reports | Flarum core | Required |
| Locking and pinning | Flarum core | Required |
| Mentions and notifications | Flarum core | Required |
| User suspension | Flarum core | Required |
| Forum privacy | Flarum core configuration | Required |

## Candidate Extension Register

| Capability | Candidate package | Production decision | Required validation |
| --- | --- | --- | --- |
| Entra login | `fof/oauth` or alternative maintained OIDC extension | Pending identity POC | Exact Flarum compatibility, immutable-subject mapping, Entra user flow, membership enforcement, logout/removal |
| File uploads | `fof/uploads` | Pending | Version support, allowed MIME types, virus scanning approach, limits, permissions, retention |
| Listing templates | `fof/discussion-templates` | Pending | Per-tag templates, required-field behavior, accessibility, upgrade/disable result |
| Pilot post approval | `fof/first-post-approval` | Pending | Exact approval semantics, moderator queue, no unintended reply suppression |
| Spam controls | `fof/anti-spam` | Pending | Provider/data transfer review, false positives, fallback, privacy |
| Tag following | `fof/follow-tags` | Pending | Notification volume, unsubscribe/preferences, version support |
| Moderator notes | `fof/moderator-notes` | Pending | Staff-only visibility, retention, export/deletion behavior |
| Object storage | selected maintained storage extension | Pending | Azure-compatible storage, backup/restore, URL exposure, version support |

## Review Checklist

For every candidate extension:

1. Pin an exact version in `composer.lock`; record the Flarum and PHP versions.
2. Review package source, maintainer activity, open security issues, compatibility declaration, license, and abandonware status.
3. Record each permission, web request, API credential, database migration, queue/scheduler requirement, and personal-data flow.
4. Install in staging only and test normal use, denial paths, upgrade, disablement, uninstallation, backup, and restore.
5. Confirm the forum remains usable if the extension is disabled and write the removal/replacement procedure.
6. Assign a PHW owner responsible for tracking releases and advisories.
7. Add evidence to the pilot readiness record before production approval.

## Prohibited Practices

- Installing packages through an unrestricted admin UI
- Using unpinned Composer constraints in production
- Applying extension updates directly to production
- Granting extensions PHW API or Key Vault credentials without a documented data flow
- Treating third-party extension groups as membership authority
- Editing extension database tables directly

## Source References

- [Flarum extensions documentation](https://docs.flarum.org/extensions)
- [FriendsOfFlarum packages](https://packagist.org/packages/fof/)
- [Flarum extension development](https://docs.flarum.org/extend)