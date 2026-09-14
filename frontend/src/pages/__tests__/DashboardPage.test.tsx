import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsApi } from '../../api/events';
import { membersApi } from '../../api/members';
import tavfApi from '../../api/tavf';
import { useTenantContext } from '../../contexts/TenantContext';
import { useAuth } from '../../hooks/useAuth';
import DashboardPage from '../DashboardPage';

vi.mock('../../api/events', () => ({
  eventsApi: {
    list: vi.fn(),
    dashboardSummary: vi.fn(),
  },
}));

vi.mock('../../api/members', () => ({
  membersApi: {
    list: vi.fn(),
    me: vi.fn(),
    rsvps: vi.fn(),
    myRsvps: vi.fn(),
  },
}));

vi.mock('../../api/tavf', () => ({
  default: {
    listPostings: vi.fn(),
  },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenantContext: vi.fn(),
  activeRoleHasAppRole: (activeRole: string | null, requiredRole: string) => {
    if (activeRole === 'admin') return true;
    if (activeRole === 'event_creator') return requiredRole !== 'ADMIN';
    if (activeRole === 'tavf_creator') return requiredRole === 'TAVF_CREATOR' || requiredRole === 'USER';
    return requiredRole === 'USER';
  },
}));

const mockedEventsApi = eventsApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  dashboardSummary: ReturnType<typeof vi.fn>;
};

const mockedMembersApi = membersApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  me: ReturnType<typeof vi.fn>;
  rsvps: ReturnType<typeof vi.fn>;
  myRsvps: ReturnType<typeof vi.fn>;
};

const mockedTavfApi = tavfApi as unknown as {
  listPostings: ReturnType<typeof vi.fn>;
};

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;
const mockedUseTenantContext = useTenantContext as unknown as ReturnType<typeof vi.fn>;

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
}

describe('DashboardPage regression coverage', () => {
  beforeEach(() => {
    mockedUseTenantContext.mockReturnValue({
      activeRole: 'member',
      activeTenant: {
        tenant_id: '527d755c-6818-40a0-bd7f-137a91b9e54e',
        slug: 'colorado-springs',
        display_name: 'Colorado Springs',
      },
    });
    mockedUseAuth.mockReturnValue({
      isAdmin: () => false,
      canCreateEvents: () => false,
      canCreateTavfPostings: () => false,
      user: {
        id: 'auth-subject-id-not-uuid',
        email: 'member@example.org',
        name: 'Member User',
      },
    });

    mockedEventsApi.list.mockResolvedValue([
      {
        event_id: 'evt-1',
        title: 'River Clinic',
        event_date: '2026-05-01T08:00:00.000Z',
        location: 'Deckers',
        description: 'Spring event',
        capacity: 4,
        yes_count: 2,
      },
    ]);
    mockedEventsApi.dashboardSummary.mockResolvedValue({
      totalEventsThisYear: 1,
      upcomingEvents: 1,
      totalRsvps: 2,
    });

    mockedMembersApi.list.mockResolvedValue({
      data: [
        {
          member_id: '11111111-1111-4111-8111-111111111111',
          first_name: 'Member',
          last_name: 'User',
          email: 'member@example.org',
          mobile_phone: null,
          sms_opt_in: false,
          email_opt_out: false,
          is_active: true,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    mockedMembersApi.me.mockResolvedValue({
      member_id: '11111111-1111-4111-8111-111111111111',
      first_name: 'Member',
      last_name: 'User',
      email: 'member@example.org',
      mobile_phone: null,
      sms_opt_in: false,
      email_opt_out: false,
      is_active: true,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    });

    mockedMembersApi.myRsvps.mockResolvedValue([]);
    mockedTavfApi.listPostings.mockResolvedValue([]);
  });

  it('loads my RSVPs using the authenticated self endpoint', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /upcoming events/i });

    await waitFor(() => {
      expect(mockedMembersApi.me).toHaveBeenCalled();
      expect(mockedMembersApi.myRsvps).toHaveBeenCalledWith(4);
    });
  });

  it('uses the active program name in the dashboard hero', async () => {
    renderPage();

    expect(await screen.findByText('Colorado Springs')).toBeInTheDocument();
    expect(screen.queryByText('Colorado Alpine Program')).not.toBeInTheDocument();
  });
});
