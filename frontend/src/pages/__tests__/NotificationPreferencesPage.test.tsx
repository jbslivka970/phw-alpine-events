import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { membersApi } from '../../api/members';
import { useAuth } from '../../hooks/useAuth';
import { NotificationPreferencesPage } from '../NotificationPreferencesPage';

vi.mock('../../api/members', () => ({
  membersApi: {
    list: vi.fn(),
    updateChannelPreference: vi.fn(),
    consentLog: vi.fn(),
    smsRolloutStatus: vi.fn(),
  },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

const mockedMembersApi = membersApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  updateChannelPreference: ReturnType<typeof vi.fn>;
  consentLog: ReturnType<typeof vi.fn>;
  smsRolloutStatus: ReturnType<typeof vi.fn>;
};

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

function renderPage() {
  return render(
    <MemoryRouter>
      <NotificationPreferencesPage />
    </MemoryRouter>
  );
}

describe('NotificationPreferencesPage regression coverage', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: {
        id: 'auth-subject-not-uuid',
        email: 'member@example.org',
      },
    });

    mockedMembersApi.list.mockResolvedValue({
      data: [
        {
          member_id: '22222222-2222-4222-8222-222222222222',
          first_name: 'Member',
          last_name: 'User',
          email: 'MEMBER@example.org',
          mobile_phone: '+13035550123',
          sms_opt_in: false,
          sms_opt_in_date: null,
          sms_opt_out_date: '2026-03-01T00:00:00.000Z',
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

    mockedMembersApi.updateChannelPreference.mockImplementation(async (id: string, channelPreference: 'email_only' | 'sms_only' | 'both') => ({
      member_id: id,
      first_name: 'Member',
      last_name: 'User',
      email: 'member@example.org',
      mobile_phone: '+13035550123',
      sms_opt_in: channelPreference !== 'email_only',
      sms_opt_in_date: channelPreference === 'email_only' ? null : '2026-03-31T00:00:00.000Z',
      sms_opt_out_date: channelPreference === 'email_only' ? '2026-03-31T00:00:00.000Z' : null,
      email_opt_out: channelPreference === 'sms_only',
      is_active: true,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    }));

    mockedMembersApi.consentLog.mockResolvedValue([]);
    mockedMembersApi.smsRolloutStatus.mockResolvedValue({
      member_id: '22222222-2222-4222-8222-222222222222',
      sms_rollout_enabled: true,
      reason: 'email_allowlist',
      configured_emails: ['member@example.org'],
      configured_groups: [],
      matched_groups: [],
    });
  });

  it('matches member by email and saves explicit SMS consent using member UUID', async () => {
    renderPage();

    await screen.findByText(/preferred channels:/i);

    const consentCheckbox = screen.getByLabelText(/I agree to receive SMS messages from Project Healing Waters Colorado Alpine Program/i);
    await userEvent.click(consentCheckbox);

    const saveButton = screen.getByRole('button', { name: /save preferences/i });
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(mockedMembersApi.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'member@example.org' })
      );
      expect(mockedMembersApi.updateChannelPreference).toHaveBeenCalledWith(
        '22222222-2222-4222-8222-222222222222',
        'both'
      );
      expect(mockedMembersApi.updateChannelPreference).not.toHaveBeenCalledWith('auth-subject-not-uuid', 'both');
    });
  });
});
