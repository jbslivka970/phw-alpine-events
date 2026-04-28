import { mapAppAccountRole, resolveRolesForRequest } from '../middleware/authRoleResolver';

describe('auth app role resolution', () => {
  it('maps app admin roles to ADMIN', () => {
    expect(mapAppAccountRole('admin')).toEqual(['ADMIN']);
    expect(mapAppAccountRole('superadmin')).toEqual(['ADMIN']);
  });

  it('maps app creator roles to app permissions', () => {
    expect(mapAppAccountRole('event_creator')).toEqual(['EVENT_CREATOR', 'USER']);
    expect(mapAppAccountRole('tavf_creator')).toEqual(['TAVF_CREATOR', 'USER']);
  });

  it('grants baseline USER from linked member when no app account role exists', () => {
    const roles = resolveRolesForRequest({
      appAccountRole: null,
      linkedMemberId: 'member-1',
      uniqueMemberByEmail: null,
      tokenRoles: [],
      allowTokenRoleFallback: false,
    });

    expect(roles).toEqual(['USER']);
  });

  it('does not use token roles when fallback is disabled', () => {
    const roles = resolveRolesForRequest({
      appAccountRole: null,
      linkedMemberId: null,
      uniqueMemberByEmail: null,
      tokenRoles: ['ADMIN'],
      allowTokenRoleFallback: false,
    });

    expect(roles).toEqual([]);
  });

  it('merges token roles only when fallback is enabled', () => {
    const roles = resolveRolesForRequest({
      appAccountRole: 'admin',
      linkedMemberId: 'member-2',
      uniqueMemberByEmail: null,
      tokenRoles: ['EVENT_CREATOR'],
      allowTokenRoleFallback: true,
    });

    expect(roles).toEqual(['ADMIN', 'USER', 'EVENT_CREATOR']);
  });

  it('returns DB-only roles when fallback is disabled, even with token claims present', () => {
    const roles = resolveRolesForRequest({
      appAccountRole: 'event_creator',
      linkedMemberId: 'member-3',
      uniqueMemberByEmail: null,
      tokenRoles: ['ADMIN'], // token tries to claim ADMIN
      allowTokenRoleFallback: false,
    });

    expect(roles).toEqual(['EVENT_CREATOR', 'USER']); // ADMIN ignored
  });
});
