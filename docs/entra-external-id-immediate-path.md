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

## 2) Configure Backend Invitation Credentials

Set these backend environment variables:
- ENTRA_PROVISIONING_TENANT_ID
- ENTRA_PROVISIONING_CLIENT_ID
- ENTRA_PROVISIONING_CLIENT_SECRET
- ENTRA_INVITE_REDIRECT_URL
- ENTRA_SEND_INVITATION_MESSAGE

Required Graph permission on the provisioning app registration:
- User.Invite.All (Application) with admin consent granted.

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
