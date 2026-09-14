import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { AdminPage } from '../AdminPage'
import { adminApi } from '../../api/admin'
import { rootApi } from '../../api/root'
import { membersApi } from '../../api/members'
import { groupsApi } from '../../api/groups'
import { eventsApi } from '../../api/events'
import { useTenantContext } from '../../contexts/TenantContext'

vi.mock('../../contexts/TenantContext', () => ({
  useTenantContext: vi.fn(),
}))

vi.mock('../../api/baseUrl', () => ({
  getApiBaseUrl: () => 'https://example.test/api/v1',
}))

vi.mock('../../api/admin', () => ({
  adminApi: {
    blastLog: vi.fn(),
    listAdminUsers: vi.fn(),
    getSupportEmailRelayConfig: vi.fn(),
    getEventSummaryEmailConfig: vi.fn(),
    getProgramCatalog: vi.fn(),
    getTenantBranding: vi.fn(),
    getTenantMessaging: vi.fn(),
    listTenantAdmins: vi.fn(),
    listTenantMemberships: vi.fn(),
  },
}))

vi.mock('../../api/root', () => ({
  rootApi: {
    getSession: vi.fn(),
    listTenants: vi.fn(),
    getAccessProfile: vi.fn(),
    upsertAccessProfile: vi.fn(),
  },
}))

vi.mock('../../api/members', () => ({
  membersApi: {
    list: vi.fn(),
  },
}))

vi.mock('../../api/groups', () => ({
  groupsApi: {
    list: vi.fn(),
  },
}))

vi.mock('../../api/events', () => ({
  eventsApi: {
    list: vi.fn(),
  },
}))

const mockedAdminApi = adminApi as unknown as {
  blastLog: ReturnType<typeof vi.fn>
  listAdminUsers: ReturnType<typeof vi.fn>
  getSupportEmailRelayConfig: ReturnType<typeof vi.fn>
  getEventSummaryEmailConfig: ReturnType<typeof vi.fn>
  getProgramCatalog: ReturnType<typeof vi.fn>
  getTenantBranding: ReturnType<typeof vi.fn>
  getTenantMessaging: ReturnType<typeof vi.fn>
  listTenantAdmins: ReturnType<typeof vi.fn>
  listTenantMemberships: ReturnType<typeof vi.fn>
}

const mockedRootApi = rootApi as unknown as {
  getSession: ReturnType<typeof vi.fn>
  listTenants: ReturnType<typeof vi.fn>
  getAccessProfile: ReturnType<typeof vi.fn>
  upsertAccessProfile: ReturnType<typeof vi.fn>
}

const mockedMembersApi = membersApi as unknown as {
  list: ReturnType<typeof vi.fn>
}

const mockedGroupsApi = groupsApi as unknown as {
  list: ReturnType<typeof vi.fn>
}

const mockedEventsApi = eventsApi as unknown as {
  list: ReturnType<typeof vi.fn>
}

const mockedUseTenantContext = useTenantContext as unknown as ReturnType<typeof vi.fn>

function mockHealthFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/health')) {
      return { ok: true, json: async () => ({ version: '9.9.9' }) }
    }
    if (url.endsWith('/health/ready')) {
      return { ok: true, json: async () => ({}) }
    }
    if (url.endsWith('/health/startup')) {
      return {
        ok: true,
        json: async () => ({
          checks: { notificationsConfigured: true, cacheProvider: 'redis' },
          runtime: { appVersion: '9.9.9', nodeEnv: 'test', nodeVersion: 'v22' },
        }),
      }
    }
    if (url.endsWith('/health/redis')) {
      return {
        ok: true,
        json: async () => ({ cache: { provider: 'redis' }, probe: { ok: true } }),
      }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch)
}

describe('AdminPage root access management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHealthFetch()

    mockedUseTenantContext.mockReturnValue({
      activeTenant: {
        tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
        slug: 'colorado-alpine',
        display_name: 'Colorado Alpine',
      },
    })

    mockedAdminApi.blastLog.mockResolvedValue({ data: [] })
    mockedAdminApi.listAdminUsers.mockResolvedValue({ data: [] })
    mockedAdminApi.getSupportEmailRelayConfig.mockResolvedValue({
      supportInboxEmail: 'support@example.test',
      relayRecipients: [],
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    })
    mockedAdminApi.getEventSummaryEmailConfig.mockResolvedValue({
      programLeadEmail: null,
      assistantProgramLeadEmails: [],
      updatedAt: null,
      updatedBy: null,
    })
    mockedAdminApi.getProgramCatalog.mockResolvedValue({ programs: [] })
    mockedAdminApi.getTenantBranding.mockResolvedValue(null)
    mockedAdminApi.getTenantMessaging.mockResolvedValue(null)
    mockedAdminApi.listTenantAdmins.mockResolvedValue({ admins: [] })
    mockedAdminApi.listTenantMemberships.mockResolvedValue({ memberships: [] })

    mockedMembersApi.list.mockResolvedValue({ total: 0, data: [] })
    mockedGroupsApi.list.mockResolvedValue([])
    mockedEventsApi.list.mockResolvedValue([])

    mockedRootApi.getSession.mockResolvedValue({
      user_id: 'root-user-1',
      email: 'sarnitro@gmail.com',
      display_name: 'Joe Ben Slivka',
      role: 'superadmin',
      is_root: true,
      root_role: 'root_admin',
    })
    mockedRootApi.listTenants.mockResolvedValue({
      tenants: [
        {
          tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
          slug: 'colorado-alpine',
          display_name: 'Colorado Alpine',
          tenant_type: 'program',
          is_demo: false,
          status: 'active',
        },
        {
          tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10002',
          slug: 'demo',
          display_name: 'Demo',
          tenant_type: 'demo',
          is_demo: true,
          status: 'active',
        },
      ],
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows root access management section for root users', async () => {
    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Root Access Management')).toBeInTheDocument()
  })

  it('hides root access management section for non-root sessions', async () => {
    mockedRootApi.getSession.mockResolvedValue({
      user_id: 'admin-user-1',
      email: 'admin@example.com',
      display_name: 'Admin User',
      role: 'admin',
      is_root: false,
      root_role: null,
    })

    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(mockedRootApi.getSession).toHaveBeenCalled()
    })

    expect(screen.queryByText('Root Access Management')).not.toBeInTheDocument()
  })

  it('loads profile and saves root access payload', async () => {
    const profile = {
      email: 'sarnitro@gmail.com',
      user: {
        user_id: 'root-user-1',
        email: 'sarnitro@gmail.com',
        display_name: 'Joe Ben Slivka',
        role: 'superadmin',
        is_active: true,
        is_root: true,
        root_role: 'root_admin',
      },
      member: {
        member_id: 'member-1',
        email: 'sarnitro@gmail.com',
        first_name: 'Joe',
        last_name: 'Slivka',
        is_active: true,
      },
      tenant_memberships: [
        {
          tenant_membership_id: 'tm-1',
          tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
          tenant_slug: 'colorado-alpine',
          tenant_name: 'Colorado Alpine',
          role: 'admin',
          membership_kind: 'home',
          status: 'active',
          starts_at: '2026-01-01T00:00:00.000Z',
          expires_at: null,
          subject_type: 'user',
        },
      ],
      personas: ['participant', 'volunteer'],
      groups: ['ADMIN'],
    }

    mockedRootApi.getAccessProfile.mockResolvedValue(profile)
    mockedRootApi.upsertAccessProfile.mockResolvedValue(profile)

    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Root Access Management')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Load Access' }))

    await waitFor(() => {
      expect(mockedRootApi.getAccessProfile).toHaveBeenCalledWith('sarnitro@gmail.com')
    })

    await userEvent.click(screen.getByRole('button', { name: 'Save Root Access' }))

    await waitFor(() => {
      expect(mockedRootApi.upsertAccessProfile).toHaveBeenCalledTimes(1)
    })

    const payload = mockedRootApi.upsertAccessProfile.mock.calls[0]?.[0]
    expect(payload.email).toBe('sarnitro@gmail.com')
    expect(payload.app_role).toBe('superadmin')
    expect(payload.is_root).toBe(true)
    expect(payload).not.toHaveProperty('tenant_memberships')
  })
})
