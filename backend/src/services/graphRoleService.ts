import { loadAuthConfig, loadEntraProvisioningConfig } from '../config';

export interface AppRoleInfo {
  id: string;
  value: string;
  displayName: string;
}

export interface UserRoleAssignment {
  assignmentId: string;
  userObjectId: string;
  appRoleId: string;
  roleName: string;
}

export interface EntraUserLookup {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
}

interface GraphUserLookupResult {
  value?: Array<{ id?: string; mail?: string | null; userPrincipalName?: string | null }>;
}

export function isGraphRoleManagementConfigured(): boolean {
  return loadEntraProvisioningConfig().isConfigured;
}

async function getGraphToken(): Promise<string> {
  const cfg = loadEntraProvisioningConfig();
  if (!cfg.isConfigured) {
    throw new Error(
      'Entra provisioning credentials are not configured. Set ENTRA_PROVISIONING_TENANT_ID, ENTRA_PROVISIONING_CLIENT_ID, and ENTRA_PROVISIONING_CLIENT_SECRET.'
    );
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Graph token acquisition failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function getApiServicePrincipal(token: string): Promise<{ id: string; appRoles: AppRoleInfo[] }> {
  const apiAppId = loadAuthConfig().clientId;
  if (!apiAppId) {
    throw new Error('AZURE_CLIENT_ID is not configured.');
  }

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${apiAppId}'&$select=id,appRoles`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Could not look up service principal for app ${apiAppId} (${response.status}). Ensure the provisioning app has Microsoft Graph application permissions Application.Read.All (or Directory.Read.All) and AppRoleAssignment.ReadWrite.All, then grant admin consent.${text ? ` Graph response: ${text.slice(0, 120)}` : ''}`
    );
  }

  const data = (await response.json()) as {
    value: Array<{ id: string; appRoles: Array<{ id: string; value: string; displayName: string }> }>;
  };

  const sp = data.value[0];
  if (!sp) {
    throw new Error(`Service principal not found for appId ${apiAppId}`);
  }

  return {
    id: sp.id,
    appRoles: (sp.appRoles ?? []).map((r) => ({ id: r.id, value: r.value, displayName: r.displayName })),
  };
}

async function getUserObjectId(email: string, token: string): Promise<string> {
  const filter = encodeURIComponent(`mail eq '${email}' or userPrincipalName eq '${email}'`);
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users?$filter=${filter}&$select=id,mail,userPrincipalName`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`User lookup failed for ${email} (${response.status}). Ensure the provisioning app has User.Read.All (or Directory.Read.All) and admin consent.${text ? ` Graph response: ${text.slice(0, 120)}` : ''}`);
  }

  const data = (await response.json()) as { value: Array<{ id: string }> };
  const user = data.value[0];
  if (!user) {
    throw new Error(`No Entra user found with email: ${email}`);
  }
  return user.id;
}

export async function listAvailableAppRoles(): Promise<AppRoleInfo[]> {
  const token = await getGraphToken();
  const { appRoles } = await getApiServicePrincipal(token);
  return appRoles;
}

export async function lookupEntraUserByEmail(email: string): Promise<EntraUserLookup | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const token = await getGraphToken();
  const safeEmail = normalizedEmail.replace(/'/g, "''");
  const queries: Array<{ filter: string; advanced: boolean }> = [
    {
      filter: `mail eq '${safeEmail}' or userPrincipalName eq '${safeEmail}'`,
      advanced: false,
    },
    {
      filter: `otherMails/any(c:c eq '${safeEmail}')`,
      advanced: true,
    },
    {
      filter: `identities/any(c:c/issuerAssignedId eq '${safeEmail}')`,
      advanced: true,
    },
  ];

  let lastError: Error | null = null;
  for (const query of queries) {
    try {
      const search = new URLSearchParams({
        '$filter': query.filter,
        '$select': 'id,mail,userPrincipalName',
      });
      if (query.advanced) {
        search.set('$count', 'true');
      }

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users?${search.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(query.advanced ? { ConsistencyLevel: 'eventual' } : {}),
          },
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Entra user lookup failed for ${normalizedEmail} (${response.status})${text ? `: ${text.slice(0, 180)}` : ''}`);
      }

      const data = (await response.json()) as GraphUserLookupResult;
      const user = data.value?.find((candidate) => typeof candidate.id === 'string');
      if (!user?.id) {
        continue;
      }

      return {
        id: user.id,
        mail: user.mail ?? null,
        userPrincipalName: user.userPrincipalName ?? null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

export async function getUserRoleAssignments(email: string): Promise<UserRoleAssignment[]> {
  const token = await getGraphToken();
  const [{ id: spId, appRoles }, userObjectId] = await Promise.all([
    getApiServicePrincipal(token),
    getUserObjectId(email, token),
  ]);

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${userObjectId}/appRoleAssignments?$select=id,appRoleId,resourceId,principalId`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Could not list role assignments (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
  }

  const data = (await response.json()) as {
    value: Array<{ id: string; principalId: string; appRoleId: string; resourceId: string }>;
  };
  const roleMap = new Map(appRoles.map((r) => [r.id, r.value]));
  const relevant = data.value.filter((assignment) => assignment.resourceId === spId);

  return relevant.map((a) => ({
    assignmentId: a.id,
    userObjectId: a.principalId,
    appRoleId: a.appRoleId,
    roleName: roleMap.get(a.appRoleId) ?? a.appRoleId,
  }));
}

export async function assignAppRole(email: string, roleValue: string): Promise<UserRoleAssignment> {
  const token = await getGraphToken();
  const [{ id: spId, appRoles }, userObjectId] = await Promise.all([
    getApiServicePrincipal(token),
    getUserObjectId(email, token),
  ]);

  const role = appRoles.find((r) => r.value.toUpperCase() === roleValue.toUpperCase());
  if (!role) {
    const available = appRoles.map((r) => r.value).join(', ');
    throw new Error(`Role '${roleValue}' not found in app manifest. Available: ${available}`);
  }

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        principalId: userObjectId,
        resourceId: spId,
        appRoleId: role.id,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Role assignment failed (${response.status})${text ? ': ' + text.slice(0, 300) : ''}`);
  }

  const data = (await response.json()) as { id: string; principalId: string; appRoleId: string };
  return {
    assignmentId: data.id,
    userObjectId: data.principalId,
    appRoleId: data.appRoleId,
    roleName: role.value,
  };
}

const GRAPH_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function removeAppRole(assignmentId: string): Promise<void> {
  if (!GRAPH_UUID_PATTERN.test(assignmentId)) {
    throw new Error('assignmentId must be a valid UUID.');
  }

  const token = await getGraphToken();
  const { id: spId } = await getApiServicePrincipal(token);

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo/${assignmentId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Role removal failed (${response.status})`);
  }
}

/**
 * Permanently deletes a user from the Entra External ID (CIAM) tenant by object ID.
 * Requires the provisioning app to have User.ReadWrite.All (application permission) with admin consent.
 * A 404 is treated as success (already deleted or never existed).
 */
export async function deleteEntraUser(entraObjectId: string): Promise<void> {
  const token = await getGraphToken();

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${entraObjectId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (response.status === 404) {
    return; // Already gone — acceptable.
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Entra user deletion failed for ${entraObjectId} (${response.status}): ${text.slice(0, 200)}`
    );
  }
}
