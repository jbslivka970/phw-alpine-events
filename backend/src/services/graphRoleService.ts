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
      `Could not look up service principal for app ${apiAppId} (${response.status}). Check that the provisioning app has AppRoleAssignment.ReadWrite.All permission on Microsoft Graph.${text ? ' ' + text.slice(0, 200) : ''}`
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
    throw new Error(`User lookup failed for ${email} (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
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

export async function getUserRoleAssignments(email: string): Promise<UserRoleAssignment[]> {
  const token = await getGraphToken();
  const [{ id: spId, appRoles }, userObjectId] = await Promise.all([
    getApiServicePrincipal(token),
    getUserObjectId(email, token),
  ]);

  const filter = encodeURIComponent(`principalId eq '${userObjectId}'`);
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo?$filter=${filter}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Could not list role assignments (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
  }

  const data = (await response.json()) as {
    value: Array<{ id: string; principalId: string; appRoleId: string }>;
  };
  const roleMap = new Map(appRoles.map((r) => [r.id, r.value]));

  return data.value.map((a) => ({
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

export async function removeAppRole(assignmentId: string): Promise<void> {
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
