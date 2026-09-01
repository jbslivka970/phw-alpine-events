# Flarum Entra External ID Runbook

Date: 2026-08-31
Applies to: staging first, then approved production only

## Outcome

Configure the selected Flarum identity path to use PHW's existing Entra External ID tenant while retaining PHW server-side control of National Gear Exchange eligibility.

This runbook does not authorize a production change. Complete the Path A proof of concept or approved Path B implementation described in [flarum-entra-integration-design.md](flarum-entra-integration-design.md) first.

## Prerequisites

- National owner approves the forum hostname, privacy policy, terms, and data-deletion contact.
- Existing PHW Entra External ID tenant and sign-up/sign-in flow are identified.
- Flarum staging hostname is HTTPS and final callback URLs are known.
- A Key Vault owner can create and rotate forum-specific client secrets.
- Test identities include an active member, no-member, expired/revoked member, Demo-only member, and a shared-email household case.
- The selected Flarum extension and Flarum core version are approved in [flarum-extension-register.md](flarum-extension-register.md).

## Entra Configuration

1. Create a separate app registration for the Flarum integration. Do not reuse the Alpine Events client ID or client secret.
2. Register only the exact HTTPS redirect URI required by the selected extension or PHW-owned extension. Register staging and production separately. Do not use wildcard redirects.
3. Configure Authorization Code Flow with PKCE. Do not enable implicit flow for the forum.
4. Set the expected audience to the Flarum-specific application registration and configure the exact Entra issuer/user-flow discovery endpoint.
5. Request the minimum required scopes: `openid`, `profile`, and `email`, plus no Graph scopes unless a separately reviewed requirement exists.
6. Store the client secret in Key Vault. Give the forum runtime identity only secret-read access. Record the expiry and rotate before it expires.
7. Configure a short, documented group/eligibility refresh interval. The final decision remains PHW server-side and must not depend solely on stale Flarum groups.

## Provider Setup

Google and Microsoft follow the existing PHW user flow. Verify each provider in the same user flow used by Flarum.

Facebook requires a National-owned Meta developer/business account. Before enabling it, provide the Meta application with:

- PHW privacy policy URL
- PHW terms URL
- User-data deletion URL and response process
- Approved application contact and security contact
- Required business verification and production review evidence

Follow the current Microsoft guidance for the exact provider redirect URIs. The existing PHW process is documented in [entra-external-id-immediate-path.md](entra-external-id-immediate-path.md).

Instagram is not enabled as a sign-in provider.

## Required Claim and Eligibility Checks

The forum integration requires an immutable subject, a usable verified email, and display name. It must call the PHW membership adapter before creating/updating access. The adapter determines eligibility from all active, non-demo memberships.

Reject the login when any of these conditions apply:

- No immutable subject
- Email missing, malformed, or unsafe for header/identity use
- No linked PHW member
- No active membership
- Membership revoked, expired, not yet active, or Demo-only
- Callback, issuer, audience, state, nonce, PKCE, signature, or expiry validation fails
- PHW membership adapter or required secret service fails

## Verification Matrix

Perform these tests in staging and record results in [flarum-pilot-readiness-evidence-template.md](flarum-pilot-readiness-evidence-template.md).

| Test | Expected result |
| --- | --- |
| Active member through Google | Access granted and immutable account linked |
| Active member through Microsoft | Access granted and immutable account linked |
| Facebook, after approval | Same behavior as other providers |
| Existing Flarum session | Identity is refreshed safely |
| Shared household email | No collision or account takeover |
| Unknown identity | Denied without account creation |
| Revoked/expired/Demo-only membership | Denied and managed access removed |
| Changed program membership | Managed group reflects change within documented interval |
| Logout and repeat login | No unauthorized session restoration |
| Invalid callback/state/nonce/PKCE | Authentication rejected |
| Secret rotation | New secret works; old secret no longer works after cutover |

## Emergency Disable and Recovery

1. Disable the PHW login provider in Flarum or set the forum read-only, according to the incident type.
2. Revoke the affected Entra client secret and any compromised Flarum credentials.
3. Preserve non-sensitive timestamps, request IDs, and operational logs. Do not export tokens, authorization codes, raw claims, or email addresses into tickets.
4. Use the designated emergency administrator account only under the National incident process.
5. Correct the issue in staging, rerun the full verification matrix, and obtain approval before re-enabling production access.