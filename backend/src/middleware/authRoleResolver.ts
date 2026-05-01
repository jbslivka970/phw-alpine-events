type AppRole = 'ADMIN' | 'EVENT_CREATOR' | 'USER' | 'TAVF_CREATOR';

function mapAppAccountRole(rawRole: string | null | undefined): AppRole[] {
  if (!rawRole) {
    return [];
  }

  const normalized = rawRole.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  if (normalized === 'admin' || normalized === 'superadmin') {
    return ['ADMIN', 'EVENT_CREATOR', 'TAVF_CREATOR', 'USER'];
  }

  if (normalized === 'event_creator') {
    return ['EVENT_CREATOR', 'USER'];
  }

  if (normalized === 'tavf_creator') {
    return ['TAVF_CREATOR', 'USER'];
  }

  if (normalized === 'user') {
    return ['USER'];
  }

  return [];
}

function mergeUniqueRoles(...roleSets: AppRole[][]): AppRole[] {
  const merged: AppRole[] = [];
  for (const roles of roleSets) {
    for (const role of roles) {
      if (!merged.includes(role)) {
        merged.push(role);
      }
    }
  }
  return merged;
}

function resolveRolesForRequest(input: {
  appAccountRole: string | null;
  linkedMemberId: string | null;
  uniqueMemberByEmail: string | null;
  tokenRoles: AppRole[];
  allowTokenRoleFallback: boolean;
}): AppRole[] {
  const appRoles = mapAppAccountRole(input.appAccountRole);
  const baselineRoles: AppRole[] = [...appRoles];

  if ((input.linkedMemberId || input.uniqueMemberByEmail) && !baselineRoles.includes('USER')) {
    baselineRoles.push('USER');
  }

  if (!input.allowTokenRoleFallback) {
    return baselineRoles;
  }

  return mergeUniqueRoles(baselineRoles, input.tokenRoles);
}

export { mapAppAccountRole, resolveRolesForRequest };
export type { AppRole };
