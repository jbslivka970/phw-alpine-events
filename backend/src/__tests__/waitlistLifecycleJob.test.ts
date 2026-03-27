import { runWaitlistLifecycleJob } from '../jobs/waitlistLifecycleJob';
import { getPool } from '../db';
import { triggerWaitlistAutoPromotion } from '../services/rsvpService';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {},
}));

jest.mock('../services/rsvpService', () => ({
  triggerWaitlistAutoPromotion: jest.fn(),
}));

describe('waitlist lifecycle job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('processes all published events with waitlist activity', async () => {
    const query = jest.fn().mockResolvedValue({
      recordset: [
        { event_id: '00000000-0000-4000-8000-000000000001' },
        { event_id: '00000000-0000-4000-8000-000000000002' },
      ],
    });

    const request = jest.fn().mockReturnValue({ query });
    (getPool as jest.Mock).mockResolvedValue({ request });
    (triggerWaitlistAutoPromotion as jest.Mock).mockResolvedValue(undefined);

    await runWaitlistLifecycleJob();

    expect(getPool).toHaveBeenCalledTimes(1);
    expect(triggerWaitlistAutoPromotion).toHaveBeenCalledTimes(2);
    expect(triggerWaitlistAutoPromotion).toHaveBeenNthCalledWith(1, '00000000-0000-4000-8000-000000000001');
    expect(triggerWaitlistAutoPromotion).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000002');
  });

  it('continues processing when a single event promotion fails', async () => {
    const query = jest.fn().mockResolvedValue({
      recordset: [
        { event_id: '00000000-0000-4000-8000-000000000003' },
        { event_id: '00000000-0000-4000-8000-000000000004' },
      ],
    });

    const request = jest.fn().mockReturnValue({ query });
    (getPool as jest.Mock).mockResolvedValue({ request });

    (triggerWaitlistAutoPromotion as jest.Mock)
      .mockRejectedValueOnce(new Error('promotion failed'))
      .mockResolvedValueOnce(undefined);

    await runWaitlistLifecycleJob();

    expect(triggerWaitlistAutoPromotion).toHaveBeenCalledTimes(2);
    expect(triggerWaitlistAutoPromotion).toHaveBeenNthCalledWith(1, '00000000-0000-4000-8000-000000000003');
    expect(triggerWaitlistAutoPromotion).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000004');
  });
});
