# Entra External ID Immediate Path

This runbook covers the non-code tenant settings required to complete the new in-app identity provisioning workflow.

## Outcome

After these steps:
- Admins can create/import members in the app.
- Admins can invite members to Entra from the Members page.
- Members can authenticate with Microsoft or Google based on your External ID user flow.
- First successful sign-in links the Entra identity back to the local member record.

## 1) Configure External ID User Flow

In Microsoft Entra admin center:
1. Open External Identities -> User flows.
2. Select the sign-up/sign-in user flow used by the app.
3. Enable self-service sign-up if you want JIT user creation.
4. Add identity providers:
   - Microsoft Account / Microsoft Entra ID
   - Google
5. Confirm email claim is included in token output.
6. Save and publish changes.

Notes:
- If you want strict pre-approval only, keep sign-up disabled and use app-driven invitations.
- If sign-up is disabled, unknown users will continue seeing account-not-found errors until invited/provisioned.

### National Gear Exchange Flarum guardrail

The planned National Gear Exchange uses Flarum but must continue to use this Entra External ID tenant and a dedicated forum application registration. Do not reuse the Alpine Events client ID or client secret. The forum integration is not approved by adding a provider to this user flow alone: it must pass the immutable-subject, active-membership, logout, access-removal, and callback-security test matrix in [flarum-entra-integration-design.md](flarum-entra-integration-design.md).

Google and Microsoft may be reused when configured in the forum user flow. Facebook requires a National-owned Meta application and its privacy policy, terms, data-deletion, and production-review prerequisites. Instagram is not a forum login provider.

Forum access must be denied unless PHW verifies an active, non-expired, non-demo program membership server-side. A social account, selected tenant, `X-Tenant-Id` header, or email match alone is not sufficient.

### Focused Google OAuth setup (copy/paste runbook)

Use this exact sequence and do not skip steps.

1. In Google Cloud Console, create or select your project.
2. Configure OAuth consent screen as External.
3. Create OAuth client credentials as Web application.
4. Add these Authorized redirect URIs exactly:

```text
https://phwalpine.ciamlogin.com/d65d23ea-9a90-4080-b5ab-f427665cbfcf/federation/oidc/google
https://phwalpine.ciamlogin.com/d65d23ea-9a90-4080-b5ab-f427665cbfcf/federation/oauth2
```

5. Save the Google values:
   - Google Client ID
   - Google Client Secret

6. In a terminal, set values and run the setup script:

```bash
export TENANT_ID="d65d23ea-9a90-4080-b5ab-f427665cbfcf"
export GOOGLE_CLIENT_ID="<paste-google-client-id>"
export GOOGLE_CLIENT_SECRET="<paste-google-client-secret>"
export PROVISIONING_CLIENT_ID="<entra-provisioning-app-client-id>"
export PROVISIONING_CLIENT_SECRET="<entra-provisioning-app-client-secret>"
export USER_FLOW_ID="<your-user-flow-id>"

./scripts/configure-external-id-google.sh \
  --tenant-id "$TENANT_ID" \
  --google-client-id "$GOOGLE_CLIENT_ID" \
  --google-client-secret "$GOOGLE_CLIENT_SECRET" \
  --provisioning-client-id "$PROVISIONING_CLIENT_ID" \
  --provisioning-client-secret "$PROVISIONING_CLIENT_SECRET" \
  --user-flow-id "$USER_FLOW_ID" \
  --create-user-flow-if-missing
```

7. If you do not know USER_FLOW_ID yet, first run:

```bash
./scripts/configure-external-id-google.sh \
  --tenant-id "$TENANT_ID" \
  --google-client-id "$GOOGLE_CLIENT_ID" \
  --google-client-secret "$GOOGLE_CLIENT_SECRET"
```

This prints available user flows, then exits without attaching.

8. Re-run the full command with USER_FLOW_ID set.

Notes:
- If provisioning client values are omitted, script falls back to Azure CLI login identity and that identity must have Graph delegated permissions for identity provider and user flow management.
- The script is idempotent: it updates existing Google provider credentials if provider already exists.

### Fast verification after script runs

1. Entra admin center -> External Identities -> User flows -> your flow -> Identity providers:
   - Confirm Google is listed.
2. Open app sign-in and verify Google appears as an option.
3. Complete one test sign-in and verify member identity status transitions from Invited to Linked.

## 2) Configure Backend Invitation Credentials

Set these backend environment variables:
- ENTRA_PROVISIONING_TENANT_ID
- ENTRA_PROVISIONING_CLIENT_ID
- ENTRA_PROVISIONING_CLIENT_SECRET
- ENTRA_INVITE_REDIRECT_URL
- ENTRA_SEND_INVITATION_MESSAGE
- AUTH_ENFORCE_MEMBER_PASSWORDLESS
- AUTH_LOCAL_PASSWORD_ALLOWLIST

Required Graph permission on the provisioning app registration:
- User.Invite.All (Application) with admin consent granted.

Recommended values for passwordless member policy:
- AUTH_ENFORCE_MEMBER_PASSWORDLESS=true
- AUTH_LOCAL_PASSWORD_ALLOWLIST contains only admin and smoke-test emails.

This policy blocks local password sign-in for non-allowlisted accounts and keeps member login on social providers and email OTP.

## 3) Apply Database Schema

Deploy the latest database schema so table member_identity_link exists.

Recommended command:

```bash
cd backend
npm run deploy-schema
```

## 4) App Admin Workflow

From Members page:
1. Create member or import CSV members.
2. Use Invite for a single member or Invite all filtered for a batch.
3. Track identity status per member: Pending, Invited, Linked, Disabled.
4. Use Relink to repair mapping if a member changed identity details.

## 5) Validation Checklist

1. New member appears in Members table.
2. Invite action succeeds from UI.
3. Member signs in with Google or Microsoft.
4. Identity status transitions to Linked.
5. Linked member receives USER access without manual role assignment.

## 6) Quick verification commands

```bash
# Backend health
curl -sS https://phwalpineeventsjb873a.azurewebsites.net/api/v1/health

# Invite one member
TOKEN=$(cat /tmp/phw_token.txt)
curl -sS -X POST \
   -H "Authorization: Bearer ${TOKEN}" \
   -H "Content-Type: application/json" \
   -d '{"member_id":"9682793C-60AC-4ED0-9FB3-29FF0DE33166"}' \
   https://phwalpineeventsjb873a.azurewebsites.net/api/v1/admin/identity/invite
```
