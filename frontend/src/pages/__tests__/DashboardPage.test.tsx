import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsApi } from '../../api/events';
import { membersApi } from '../../api/members';
import tavfApi from '../../api/tavf';
import { useAuth } from '../../hooks/useAuth';
import DashboardPage from '../DashboardPage';

vi.mock('../../api/events', () => ({
  eventsApi: {
    list: vi.fn(),
  },
}));

vi.mock('../../api/members', () => ({
  membersApi: {
    list: vi.fn(),
    rsvps: vi.fn(),
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

const mockedEventsApi = eventsApi as unknown as {
  list: ReturnType<typeof vi.fn>;
};

const mockedMembersApi = membersApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  rsvps: ReturnType<typeof vi.fn>;
};

const mockedTavfApi = tavfApi as unknown as {
  listPostings: ReturnType<typeof vi.fn>;
};

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );
}

describe('DashboardPage regression coverage', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      isAdmin: () => false,
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

    mockedMembersApi.rsvps.mockResolvedValue([]);
    mockedTavfApi.listPostings.mockResolvedValue([]);
  });

  it('resolves member by email and loads rsvps by member_id UUID', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /upcoming events/i });

    await waitFor(() => {
      expect(mockedMembersApi.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'member@example.org' })
      );
      expect(mockedMembersApi.rsvps).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
      expect(mockedMembersApi.rsvps).not.toHaveBeenCalledWith('auth-subject-id-not-uuid');
    });
  });
});
