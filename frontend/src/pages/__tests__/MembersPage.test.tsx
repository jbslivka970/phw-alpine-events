import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '../../api/admin';
import { membersApi } from '../../api/members';
import { useAuth } from '../../hooks/useAuth';
import { MembersPage } from '../MembersPage';

vi.mock('../../api/admin', () => ({
  adminApi: {
    identityStatus: vi.fn(),
    identityStatusBulk: vi.fn(),
    inviteIdentity: vi.fn(),
    inviteIdentityBulk: vi.fn(),
    relinkIdentity: vi.fn(),
  },
}));

vi.mock('../../api/members', () => ({
  membersApi: {
    list: vi.fn(),
    consentLog: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateSmsConsent: vi.fn(),
  },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

const mockedAdminApi = adminApi as unknown as {
  identityStatus: ReturnType<typeof vi.fn>;
  identityStatusBulk: ReturnType<typeof vi.fn>;
  inviteIdentity: ReturnType<typeof vi.fn>;
  inviteIdentityBulk: ReturnType<typeof vi.fn>;
  relinkIdentity: ReturnType<typeof vi.fn>;
};

const mockedMembersApi = membersApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  consentLog: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateSmsConsent: ReturnType<typeof vi.fn>;
};

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

const members = [
  {
    member_id: 'm-1',
    first_name: 'Mike',
    last_name: 'Rivera',
    email: 'mike@example.com',
    mobile_phone: null,
    sms_opt_in: false,
    email_opt_out: false,
    is_active: true,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
  },
  {
    member_id: 'm-2',
    first_name: 'Casey',
    last_name: 'Wong',
    email: 'casey@example.com',
    mobile_phone: null,
    sms_opt_in: false,
    email_opt_out: false,
    is_active: true,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
  },
];

function makeStatus(memberId: string, status: 'pending' | 'invited' | 'linked' | 'disabled') {
  return {
    member_id: memberId,
    status,
    identity_provider: null,
    entra_object_id: null,
    issuer: null,
    issuer_assigned_id: null,
    invited_at: null,
    invite_email_sent_at: null,
    linked_at: null,
    last_sign_in_at: null,
    updated_at: null,
  };
}

describe('MembersPage identity workflow', () => {
  let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn>;
  let anchorClickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      isAdmin: () => true,
    });

    mockedMembersApi.list.mockResolvedValue({
      data: members,
      total: 2,
      page: 1,
      pageSize: 100,
    });

    mockedMembersApi.consentLog.mockResolvedValue([]);
    mockedMembersApi.create.mockResolvedValue(members[0]);
    mockedMembersApi.update.mockResolvedValue(members[0]);
    mockedMembersApi.updateSmsConsent.mockResolvedValue(members[0]);

    mockedAdminApi.identityStatusBulk.mockResolvedValue({
      data: [
        makeStatus('m-1', 'linked'),
        makeStatus('m-2', 'pending'),
      ],
    });

    mockedAdminApi.identityStatus.mockResolvedValue(makeStatus('m-1', 'invited'));
    mockedAdminApi.inviteIdentity.mockResolvedValue({
      member_id: 'm-1',
      email: 'mike@example.com',
      status: 'invited',
      invitation_id: 'inv-1',
      invited_user_id: 'user-1',
      invite_redeem_url: 'https://example.com/redeem',
    });
    mockedAdminApi.inviteIdentityBulk.mockResolvedValue({
      results: [
        { member_id: 'm-1', status: 'invited' },
        { member_id: 'm-2', status: 'invited' },
      ],
    });
    mockedAdminApi.relinkIdentity.mockResolvedValue(makeStatus('m-1', 'linked'));

    createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:members-export');
    revokeObjectUrlSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    createObjectUrlSpy.mockRestore();
    revokeObjectUrlSpy.mockRestore();
    anchorClickSpy.mockRestore();
  });

  it('shows identity status column from bulk status API', async () => {
    render(<MembersPage />);

    await screen.findByText('Mike Rivera');

    await waitFor(() => {
      expect(mockedAdminApi.identityStatusBulk).toHaveBeenCalledWith(['m-1', 'm-2']);
    });

    expect(screen.getByRole('cell', { name: 'Accepted' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Pending invite' })).toBeInTheDocument();
  });

  it('invites one member and refreshes identity status', async () => {
    render(<MembersPage />);

    await screen.findByText('Mike Rivera');
    const inviteButtons = screen.getAllByRole('button', { name: 'Invite' });

    await userEvent.click(inviteButtons[0]);

    await waitFor(() => {
      expect(mockedAdminApi.inviteIdentity).toHaveBeenCalledWith('m-1');
      expect(mockedAdminApi.identityStatus).toHaveBeenCalledWith('m-1');
    });

    expect(screen.getByRole('cell', { name: 'Invited' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open redeem link' })).toHaveAttribute('href', 'https://example.com/redeem');
  });

  it('bulk invites filtered members and refreshes statuses', async () => {
    mockedAdminApi.identityStatusBulk
      .mockResolvedValueOnce({ data: [makeStatus('m-1', 'pending'), makeStatus('m-2', 'pending')] })
      .mockResolvedValueOnce({ data: [makeStatus('m-1', 'invited'), makeStatus('m-2', 'invited')] });

    render(<MembersPage />);

    await screen.findByText('Mike Rivera');
    await userEvent.click(screen.getByRole('button', { name: 'Invite all filtered' }));

    await waitFor(() => {
      expect(mockedAdminApi.inviteIdentityBulk).toHaveBeenCalledWith(['m-1', 'm-2']);
    });

    expect(await screen.findAllByRole('cell', { name: 'Invited' })).toHaveLength(2);
  });

  it('shows invite summary and exports filtered csv', async () => {
    render(<MembersPage />);

    await screen.findByText('Mike Rivera');

    await waitFor(() => {
      expect(screen.getByText('Pending invite: 1')).toBeInTheDocument();
      expect(screen.getByText('Accepted: 1')).toBeInTheDocument();
    });

    await userEvent.selectOptions(screen.getByLabelText('Invite status'), 'accepted');
    await userEvent.click(screen.getByRole('button', { name: 'Export filtered CSV' }));

    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlSpy).toHaveBeenCalledTimes(1);
  });
});
