import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsApi, rsvpApi } from '../../api/events';
import { groupsApi } from '../../api/groups';
import { useAuth } from '../../hooks/useAuth';
import { EventsPage } from '../EventsPage';

vi.mock('../../api/events', () => ({
  eventsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    downloadIcs: vi.fn(),
  },
  rsvpApi: {
    list: vi.fn(),
  },
}));

vi.mock('../../api/groups', () => ({
  groupsApi: {
    list: vi.fn(),
  },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

const mockedEventsApi = eventsApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  downloadIcs: ReturnType<typeof vi.fn>;
};

const mockedRsvpApi = rsvpApi as unknown as {
  list: ReturnType<typeof vi.fn>;
};

const mockedGroupsApi = groupsApi as unknown as {
  list: ReturnType<typeof vi.fn>;
};

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

const eventRecord = {
  event_id: 'e-1111',
  title: 'River Day',
  description: 'Annual spring trip',
  location: 'Clear Creek',
  photo_url: null,
  event_date: '2026-05-01T08:00:00.000Z',
  end_date: null,
  mentor_capacity: 1,
  participant_capacity: 1,
  capacity: 2,
  status: 'draft',
  created_by: null,
  created_at: '2026-03-30T00:00:00.000Z',
  updated_at: '2026-03-30T00:00:00.000Z',
  yes_count: 0,
  target_count: 0,
} as const;

function renderPage() {
  return render(
    <MemoryRouter>
      <EventsPage />
    </MemoryRouter>
  );
}

function setFieldByLabel(labelText: string, value: string) {
  const label = screen.getByText(labelText);
  const field = label.parentElement?.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  if (!field) {
    throw new Error(`Field not found for label: ${labelText}`);
  }
  return userEvent.clear(field).then(async () => {
    if (value) {
      await userEvent.type(field, value);
    }
  });
}

describe('EventsPage flow pattern', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      isAdmin: () => false,
      canCreateEvents: () => true,
      user: { id: 'u-1' },
    });
    mockedEventsApi.list.mockResolvedValue([eventRecord]);
    mockedEventsApi.get.mockResolvedValue({ ...eventRecord, notification_targets: [] });
    mockedEventsApi.create.mockResolvedValue({ ...eventRecord, event_id: 'e-2222' });
    mockedEventsApi.update.mockResolvedValue({ ...eventRecord, title: 'Updated River Day' });
    mockedEventsApi.updateStatus.mockResolvedValue({ ...eventRecord, status: 'cancelled' });
    mockedEventsApi.downloadIcs.mockResolvedValue({ blob: new Blob(['x'], { type: 'text/calendar' }), headers: new Headers() });
    mockedGroupsApi.list.mockResolvedValue([]);
    mockedRsvpApi.list.mockResolvedValue([]);
  });

  it('creates a new event with normalized payload', async () => {
    renderPage();

    await screen.findByRole('heading', { name: 'Events' });
    await userEvent.click(screen.getByRole('button', { name: /\+ New Event/i }));

    await setFieldByLabel('Title *', 'Summer Opener');
    await setFieldByLabel('Event Date *', '2026-06-10');
    await setFieldByLabel('Event Time (24-hour) *', '1923');
    await setFieldByLabel('Location', 'Blue Mesa');
    await setFieldByLabel('Mentor Capacity', '1');
    await setFieldByLabel('Participant Capacity', '2');
    await setFieldByLabel('Description', 'First evening outing');

    await userEvent.click(screen.getByRole('button', { name: 'Create Event' }));

    await waitFor(() => {
      expect(mockedEventsApi.create).toHaveBeenCalledWith({
        title: 'Summer Opener',
        event_date: '2026-06-10T19:23',
        description: 'First evening outing',
        location: 'Blue Mesa',
        photo_url: null,
        end_date: null,
        mentor_capacity: 1,
        participant_capacity: 2,
        capacity: 3,
        notification_targets: [],
      });
    });
  });

  it('edits an event and submits update reason', async () => {
    renderPage();

    await screen.findByRole('button', { name: 'Edit' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByText('Title *');

    await setFieldByLabel('Title *', 'River Day Updated');
    await setFieldByLabel('Update Reason', 'Adjusted agenda');

    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(mockedEventsApi.update).toHaveBeenCalledWith('e-1111', expect.objectContaining({
        title: 'River Day Updated',
        update_reason: 'Adjusted agenda',
      }));
    });
  });

  it('transitions event status to cancelled', async () => {
    renderPage();

    const eventTitle = await screen.findByRole('heading', { name: 'River Day' });
    const eventCard = eventTitle.closest('.event-card');
    if (!eventCard) {
      throw new Error('Event card container not found');
    }
    await userEvent.click(within(eventCard).getByRole('button', { name: 'Cancelled' }));

    await waitFor(() => {
      expect(mockedEventsApi.updateStatus).toHaveBeenCalledWith('e-1111', 'cancelled');
    });
  });
});
