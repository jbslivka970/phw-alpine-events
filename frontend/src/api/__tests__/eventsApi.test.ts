import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDelete, apiGet, apiGetBlob, apiPost, apiPut } from '../client';
import { eventsApi } from '../events';

vi.mock('../client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  apiPatch: vi.fn(),
  apiGetBlob: vi.fn(),
}));

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>;
const mockedApiPost = apiPost as unknown as ReturnType<typeof vi.fn>;
const mockedApiPut = apiPut as unknown as ReturnType<typeof vi.fn>;
const mockedApiDelete = apiDelete as unknown as ReturnType<typeof vi.fn>;
const mockedApiGetBlob = apiGetBlob as unknown as ReturnType<typeof vi.fn>;

describe('eventsApi contract', () => {
  beforeEach(() => {
    mockedApiGet.mockResolvedValue([]);
    mockedApiPost.mockResolvedValue({});
    mockedApiPut.mockResolvedValue({});
    mockedApiDelete.mockResolvedValue(undefined);
    mockedApiGetBlob.mockResolvedValue({ blob: new Blob(['x']), headers: new Headers() });
  });

  it('calls create endpoint with POST /events', async () => {
    const payload = { title: 'Test', event_date: '2026-06-10T19:23' };
    await eventsApi.create(payload);
    expect(mockedApiPost).toHaveBeenCalledWith('/events', payload);
  });

  it('calls update endpoint with PUT /events/:id', async () => {
    const payload = { title: 'Updated' };
    await eventsApi.update('event-1', payload);
    expect(mockedApiPut).toHaveBeenCalledWith('/events/event-1', payload);
  });

  it('calls delete endpoint with DELETE /events/:id', async () => {
    await eventsApi.remove('event-1');
    expect(mockedApiDelete).toHaveBeenCalledWith('/events/event-1');
  });
});
