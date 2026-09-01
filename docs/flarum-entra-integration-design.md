# Flarum and Entra External ID Integration Design

Date: 2026-08-31
Status: Design and proof-of-concept gate

## Objective

Allow active PHW program members to use the same Entra External ID sign-in experience they use for Alpine Events while preventing social identity alone from granting access to the National Gear Exchange.

## Membership Authority

The PHW backend is the authorization authority. It evaluates every forum-access decision using `listTenantsForAuthenticatedUser` in [`backend/src/services/tenantContextService.ts`](../backend/src/services/tenantContextService.ts). An eligible person has at least one active membership whose start date has passed, end date is absent or future, and tenant is not Demo/non-operational.

Never authorize using `X-Tenant-Id`, browser local storage, an email match alone, a selected program, a Flarum group alone, or a token role claim alone. Dependency errors deny access until resolved.

## Minimum Identity Contract

| Field | Source | Use | Restrictions |
| --- | --- | --- | --- |
| `sub` | normalized `req.user.sub`, based on immutable Entra object identity | primary external account association | Required; never replace with email |
| `email` | usable Entra-verified email after PHW validation | Flarum account contact/recovery | Required; not unique and not authorization evidence |
| `name` | PHW member first/last name or validated Entra display name | forum display name | Do not expose internal notes |
| `groups` | server-derived active program and approved moderation groups | scoped forum permissions | No raw tenant IDs or role claims unless required |

Never send phone numbers, postal addresses, member notes, raw Entra claims, provider-specific identifiers, access tokens, refresh tokens, ID tokens, invitation tokens, or PHW event records.

## Path A: Community Extension Proof of Concept

Path A is acceptable only when one exact Flarum extension version supports Entra External ID using Authorization Code Flow with PKCE and meets every test below. The current candidate is a maintained OAuth/OIDC extension such as `fof/oauth`; this is a candidate, not an approval or claim of Entra compatibility.

Required proof:

1. Discovery, issuer, authorization endpoint, token endpoint, JWKS, and user-info behavior work with the PHW external tenant and user flow.
2. Exact callback URI, `state`, nonce when applicable, PKCE, token audience, issuer, signature, and expiry are validated.
3. Flarum associates an account by immutable Entra subject. Email-only matching is rejected because PHW permits shared household email addresses.
4. Login succeeds for an active real-program member and fails for absent, revoked, expired, and Demo-only members.
5. A changed program membership refreshes group/permission access according to the documented maximum delay.
6. Sign-out and re-authentication cannot restore access after PHW removes membership.
7. Browser code never passes an Alpine Events bearer token or a self-asserted eligibility value to Flarum.
8. Logs omit tokens, authorization codes, state, nonce, signatures, raw claims, and email addresses.

If any condition fails, stop Path A and choose Path B. Do not weaken the eligibility contract to fit an extension.

## Path B: PHW-Owned Flarum Extension

Path B is a small Flarum extension that owns only the PHW login provider integration. It does not make Alpine Events an OIDC provider and it does not copy forum records back to Alpine Events.

The extension must:

1. Implement Authorization Code Flow with PKCE against the Entra External ID discovery document.
2. Validate state, nonce, issuer, audience, token signature through JWKS, expiry, and exact redirect URI.
3. Establish the immutable Entra subject and obtain only the minimum identity claims.
4. Call a protected PHW server-to-server membership adapter. The adapter validates its own workload credential and returns allow/deny plus minimal display/group data.
5. Create or update the Flarum account only after a positive membership decision. Map by immutable subject, not email.
6. Apply only `phw-members`, `program-<slug>`, `exchange-moderators`, and `exchange-admins` groups approved by the response contract. Remove managed groups no longer present.
7. Fail closed on PHW adapter, database, Key Vault, discovery, signature, or group-sync failures.
8. Provide explicit account suspension/logout behavior for member removal and emergency disablement.

The extension is subject to normal PHP code review, automated tests, dependency review, staging, security review, and a rollback plan. It must live in a dedicated repository with its own pinned Flarum compatibility matrix.

## Entra and Social Providers

Use the existing PHW Entra External ID tenant and sign-up/sign-in user flow. Google and Microsoft remain available where currently configured. Facebook requires a National-owned Meta application, privacy policy URL, terms URL, data-deletion URL, production readiness review, and credential owner. See [entra-external-id-immediate-path.md](entra-external-id-immediate-path.md) for the existing provider workflow.

Instagram is not a PHW Gear Exchange login provider.

## Flarum Group Mapping

| PHW condition | Flarum group |
| --- | --- |
| eligible member | `phw-members` |
| active membership in a real program | `program-<tenant-slug>` |
| separately National-approved moderator | `exchange-moderators` |
| separately National-approved administrator | `exchange-admins` |

Do not translate all PHW `admin`, `root_admin`, `event_creator`, or `tavf_creator` roles into forum staff privileges. National approval and an allowlist are required because staff permissions can be forum-wide.

## Security Test Matrix

| Scenario | Expected result |
| --- | --- |
| no authentication | no forum access |
| valid active member | one Flarum account linked by immutable subject |
| duplicate household email | no account collision or privilege transfer |
| missing/unsafe email | no account creation or access |
| no membership | deny access |
| revoked/expired membership | deny access and remove managed groups/session as designed |
| Demo-only membership | deny access |
| altered callback URI, state, nonce, or PKCE verifier | deny authentication |
| altered issuer, audience, signature, or expiry | deny authentication |
| PHW adapter failure | deny access; emit non-sensitive operational event |
| group removal | managed Flarum group removed within the documented refresh window |
| staff allowlist removal | staff group removed and access rechecked |

## Implementation References

- Existing JWT validation and sanitized identity handling: [`backend/src/middleware/auth.ts`](../backend/src/middleware/auth.ts)
- Existing Entra configuration: [`backend/src/config.ts`](../backend/src/config.ts)
- Existing member token acquisition: [`frontend/src/hooks/useAuth.ts`](../frontend/src/hooks/useAuth.ts)
- Existing tenant access model: [multi-tenant-design.md](multi-tenant-design.md)
- OIDC standard: <https://openid.net/specs/openid-connect-core-1_0.html>