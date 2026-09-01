# Flarum National Gear Exchange Pilot Readiness Evidence

Copy this file to a dated evidence record before the pilot. Do not store secrets, access tokens, authorization codes, raw claims, personal addresses, or member exports in the evidence record.

Date:
Release/commit reference:
Environment: Staging / Production
Operator:
Reviewer:

## Versions and Ownership

| Item | Value | Verified by | Date |
| --- | --- | --- | --- |
| Flarum core | | | |
| PHP | | | |
| Database engine/version | | | |
| Operating system/image | | | |
| Extension lockfile reference | | | |
| National service owner | | | |
| Forum operator | | | |
| Moderator lead | | | |
| Privacy/security contact | | | |

## Infrastructure

| Check | Pass/Fail | Evidence location or non-sensitive result | Owner |
| --- | --- | --- | --- |
| Private forum access configured | | | |
| HTTPS and certificate monitoring | | | |
| SMTP controlled test mail | | | |
| Backup completed and encrypted off-box | | | |
| Isolated restore completed | | | |
| Scheduler/queue healthy | | | |
| VM/database/storage monitoring | | | |
| Emergency admin recovery tested | | | |

## Identity Matrix

| Scenario | Expected result | Actual result | Pass/Fail |
| --- | --- | --- | --- |
| Active Google member | Access granted | | |
| Active Microsoft member | Access granted | | |
| Facebook member, if enabled | Access granted | | |
| Missing membership | Access denied | | |
| Expired/revoked membership | Access denied | | |
| Demo-only membership | Access denied | | |
| Shared household email | No account collision | | |
| Program change | Managed group refreshes | | |
| Logout/re-login | Access rechecked | | |
| Invalid callback/state/nonce/PKCE | Authentication rejected | | |
| Secret rotation | Controlled cutover succeeds | | |

## Community and Moderation

| Check | Pass/Fail | Notes |
| --- | --- | --- |
| ISO/Available, activity, lifecycle, and origin tags | | |
| Listing template/required fields | | |
| Attachment controls | | |
| New-listing approval queue | | |
| Flag triage and escalation | | |
| Hide/lock/suspend actions | | |
| Stale-listing process | | |
| Moderator training and access review | | |

## Accessibility and Security

| Check | Pass/Fail | Notes |
| --- | --- | --- |
| Keyboard-only listing and moderation paths | | |
| Screen-reader sign-in and form labels | | |
| Mobile layouts | | |
| Anonymous content inaccessible | | |
| Member removal denies forum access | | |
| No sensitive values in tested logs | | |
| Extension compatibility/disable test | | |

## Pilot Decision

Pilot programs:

Start date:

End/review date:

Known risks and mitigations:

Approval decision: Approved / Blocked / Approved with conditions

National service owner signature/approval reference: