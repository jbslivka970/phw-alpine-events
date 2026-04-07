import { loadEntraProvisioningConfig } from '../config';

interface EntraInvitationRequest {
  email: string;
  displayName?: string | null;
  redirectUrl?: string;
}

interface EntraInvitationResult {
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
  const redirectUrl = input.redirectUrl?.trim() || cfg.redirectUrl;

  if (!redirectUrl) {
    throw new Error('invite redirect URL is required (configure ENTRA_INVITE_REDIRECT_URL).');
  }

  const requestBody = {
    invitedUserEmailAddress: input.email,
    invitedUserDisplayName: input.displayName ?? undefined,
    inviteRedirectUrl: redirectUrl,
    sendInvitationMessage: cfg.sendInvitationMessage,
  };

  const response = await fetch('https://graph.microsoft.com/v1.0/invitations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${graphToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Graph invitation request failed: ${response.status} ${detail}`);
  }

  return (await response.json()) as EntraInvitationResult;
}

export { isProvisioningEnabled, sendEntraInvitation };
export type { EntraInvitationRequest, EntraInvitationResult };
