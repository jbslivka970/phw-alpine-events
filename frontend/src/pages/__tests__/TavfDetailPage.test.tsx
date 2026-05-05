import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tavfApi from '../../api/tavf';
import { useAuth } from '../../hooks/useAuth';
import { TavfDetailPage } from '../TavfDetailPage';

vi.mock('../../api/tavf', () => ({
  default: {
    getPosting: vi.fn(),
    listApplications: vi.fn(),
    listMatches: vi.fn(),
    createMatch: vi.fn(),
    deleteMatch: vi.fn(),
    updateApplicationStatus: vi.fn(),
    deletePosting: vi.fn(),
    updatePosting: vi.fn(),
    applyToPosting: vi.fn(),
  },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

const mockedApi = tavfApi as unknown as {
  getPosting: ReturnType<typeof vi.fn>;
  listApplications: ReturnType<typeof vi.fn>;
  listMatches: ReturnType<typeof vi.fn>;
  createMatch: ReturnType<typeof vi.fn>;
  deleteMatch: ReturnType<typeof vi.fn>;
  updateApplicationStatus: ReturnType<typeof vi.fn>;
  deletePosting: ReturnType<typeof vi.fn>;
  updatePosting: ReturnType<typeof vi.fn>;
  applyToPosting: ReturnType<typeof vi.fn>;
};

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

const posting = {
  posting_id: 'p-1111',
  guide_member_id: 'guide-1',
  event_date: '2026-04-15',
  location: 'Cherry Creek Reservoir',
  capacity: 1,
  species: 'Walleye',
  description: 'Evening bite near the marina',
  status: 'open',
  created_at: '2026-03-30T10:00:00Z',
  updated_at: '2026-03-30T10:00:00Z',
} as const;

const application = {
  application_id: 'a-3333',
  posting_id: 'p-1111',
  vet_member_id: 'member-abc',
  first_name: 'Casey',
  last_name: 'Member',
  notes: 'I have my own gear.',
  status: 'pending',
  applied_at: '2026-03-30T11:00:00Z',
  updated_at: '2026-03-30T11:00:00Z',
} as const;

function renderPage(route = '/tavf/p-1111') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/tavf/:id" element={<TavfDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('TavfDetailPage flow pattern', () => {
  beforeEach(() => {
    mockedApi.getPosting.mockResolvedValue(posting);
    mockedApi.listApplications.mockResolvedValue([application]);
    mockedApi.listMatches.mockResolvedValue([]);
    mockedApi.createMatch.mockResolvedValue({
      match_id: 'm-1',
      posting_id: posting.posting_id,
      application_id: application.application_id,
      matched_by: null,
      matched_at: '2026-03-30T12:00:00Z',
      status: 'confirmed',
      notes: null,
    });
    mockedApi.updateApplicationStatus.mockResolvedValue({ ...application, status: 'waitlisted' });
    mockedApi.deleteMatch.mockResolvedValue(undefined);
    mockedApi.deletePosting.mockResolvedValue(undefined);
    mockedApi.updatePosting.mockResolvedValue({ ...posting, status: 'filled' });
    mockedApi.applyToPosting.mockResolvedValue({ ...application, application_id: 'a-9999' });
  });

  it('loads posting data for admin flow', async () => {
    mockedUseAuth.mockReturnValue({
      isAdmin: () => true,
      canCreateEvents: () => true,
      user: { id: 'user-1' },
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Cherry Creek Reservoir' })).toBeInTheDocument();
    expect(screen.getByText(/Applications/i)).toBeInTheDocument();
    expect(screen.getByText('Casey Member')).toBeInTheDocument();
    expect(mockedApi.getPosting).toHaveBeenCalledWith('p-1111');
    expect(mockedApi.listApplications).toHaveBeenCalledWith('p-1111');
    expect(mockedApi.listMatches).toHaveBeenCalled();
  });

  it('confirms a match without sending matched_by', async () => {
    mockedUseAuth.mockReturnValue({
      isAdmin: () => true,
      canCreateEvents: () => true,
      user: { id: 'non-uuid-auth-sub' },
    });

    renderPage();

    const confirmButton = await screen.findByRole('button', { name: /Confirm match/i });
    await userEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockedApi.createMatch).toHaveBeenCalledWith({
        posting_id: 'p-1111',
        application_id: 'a-3333',
      });
    });
  });

  it('surfaces backend error when match creation fails', async () => {
    mockedUseAuth.mockReturnValue({
      isAdmin: () => true,
      canCreateEvents: () => true,
      user: { id: 'user-1' },
    });
    mockedApi.createMatch.mockRejectedValue(new Error('Internal server error'));

    renderPage();

    const confirmButton = await screen.findByRole('button', { name: /Confirm match/i });
    await userEvent.click(confirmButton);

    expect(await screen.findByText('Internal server error')).toBeInTheDocument();
  });

  it('allows member application flow for non-admin users', async () => {
    const memberId = '11111111-1111-4111-8111-111111111111';
    mockedUseAuth.mockReturnValue({
      isAdmin: () => false,
      canCreateEvents: () => false,
      user: { id: memberId },
    });
    mockedApi.listApplications.mockResolvedValue([]);

    renderPage();

    const submitButton = await screen.findByRole('button', { name: /Confirm Interest/i });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(mockedApi.applyToPosting).toHaveBeenCalledWith('p-1111', {
        vet_member_id: memberId,
        notes: undefined,
      });
    });
  });
});
