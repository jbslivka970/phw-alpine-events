import { randomBytes } from 'crypto';
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

async function issueGraphAccessToken(): Promise<string> {
  const cfg = loadEntraProvisioningConfig();
  if (!cfg.isConfigured) {
    throw new Error('Entra provisioning is not configured.');
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to acquire Graph token: ${response.status} ${detail}`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Failed to acquire Graph token: access_token missing in response.');
  }

  return payload.access_token;
}

async function sendEntraInvitation(input: EntraInvitationRequest): Promise<EntraInvitationResult> {
  const cfg = loadEntraProvisioningConfig();
  if (!cfg.isConfigured) {
    throw new Error('Entra provisioning is not configured.');
  }

  const graphToken = await issueGraphAccessToken();
  const redirectUrl = input.redirectUrl?.trim() || cfg.redirectUrl || '';

  // Derive the onmicrosoft.com issuer domain from the tenant name.
  // This is required for CIAM local emailAddress identities.
  const tenantDomain = cfg.tenantName ? `${cfg.tenantName}.onmicrosoft.com` : '';

  // Graph API requires a passwordProfile even for social-only users.
  // The user will sign in via Google or Email OTP, not this password.
  const tempPassword = `${randomBytes(10).toString('base64url')}Aa1!`;

  const requestBody: Record<string, unknown> = {
    accountEnabled: true,
    displayName: input.displayName ?? input.email,
    passwordProfile: {
      password: tempPassword,
      forceChangePasswordNextSignIn: false,
    },
    passwordPolicies: 'DisablePasswordExpiration',
  };

  if (tenantDomain) {
    requestBody['identities'] = [
      {
        signInType: 'emailAddress',
        issuer: tenantDomain,
        issuerAssignedId: input.email.toLowerCase(),
      },
    ];
  }

  const response = await fetch('https://graph.microsoft.com/v1.0/users', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${graphToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  // 409 means this email is already provisioned in CIAM — treat as success.
  if (response.status === 409) {
    return {
      id: undefined,
      invitedUserEmailAddress: input.email,
      invitedUserDisplayName: input.displayName ?? undefined,
      invitedUser: { id: undefined },
      inviteRedeemUrl: redirectUrl || undefined,
      status: 'already_provisioned',
    };
  }

  // Graph can also return 400/ObjectConflict when the derived userPrincipalName already exists.
  // Treat this as idempotent success for invite retries on existing CIAM users.
  if (response.status === 400) {
    const detail = await response.text().catch(() => response.statusText);
    if (detail.includes('ObjectConflict') || detail.includes('userPrincipalName already exists')) {
      return {
        id: undefined,
        invitedUserEmailAddress: input.email,
        invitedUserDisplayName: input.displayName ?? undefined,
        invitedUser: { id: undefined },
        inviteRedeemUrl: redirectUrl || undefined,
        status: 'already_provisioned',
      };
    }

    throw new Error(`CIAM user provisioning failed: ${response.status} ${detail}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`CIAM user provisioning failed: ${response.status} ${detail}`);
  }

  const user = (await response.json()) as { id?: string };
  return {
    id: user.id,
    invitedUserEmailAddress: input.email,
    invitedUserDisplayName: input.displayName ?? undefined,
    invitedUser: { id: user.id },
    // Return the app sign-in URL so admins can share it directly with the member.
    inviteRedeemUrl: redirectUrl || undefined,
    status: 'provisioned',
  };
}

export { isProvisioningEnabled, sendEntraInvitation };
export type { EntraInvitationRequest, EntraInvitationResult };
