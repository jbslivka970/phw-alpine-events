import { loadEntraProvisioningConfig } from '../config';

interface EntraInvitationRequest {
  email: string;
  displayName?: string | null;
  redirectUrl?: string;
}

interface EntraInvitationResult {
  id?: string;
  invitedUserEmailAddress: string;
  invitedUserDisplayName?: string;
  invitedUser?: {
    id?: string;
  };
  inviteRedeemUrl?: string;
  status?: string;
}

function isProvisioningEnabled(): boolean {
  const cfg = loadEntraProvisioningConfig();
  return cfg.isConfigured;
}

async function sendEntraInvitation(input: EntraInvitationRequest): Promise<EntraInvitationResult> {
  const cfg = loadEntraProvisioningConfig();
  if (!cfg.isConfigured) {
    throw new Error('Entra provisioning is not configured.');
  }

  const redirectUrl = input.redirectUrl?.trim() || cfg.redirectUrl || '';

  // Do NOT pre-create a local CIAM password account. Pre-creating a local
  // emailAddress identity with a passwordProfile causes CIAM to show a
  // "Enter password" prompt and blocks Google / Email OTP sign-in flows.
  //
  // Members are auto-linked by email in the auth middleware on first sign-in.
  // The invite in our system is purely a DB record + the app sign-in URL.
  return {
    id: undefined,
    invitedUserEmailAddress: input.email,
    invitedUserDisplayName: input.displayName ?? undefined,
    invitedUser: { id: undefined },
    inviteRedeemUrl: redirectUrl || undefined,
    status: 'provisioned',
  };
}

export { isProvisioningEnabled, sendEntraInvitation };
export type { EntraInvitationRequest, EntraInvitationResult };
