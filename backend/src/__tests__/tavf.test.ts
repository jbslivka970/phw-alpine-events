/**
 * Unit tests for TaVF routes.
 * The database and service layer are fully mocked so no real SQL
 * connection is required.
 */

import request from 'supertest';
import express from 'express';
import authenticate from '../middleware/auth';
import tavfRouter from '../routes/tavf';
import * as tavfService from '../services/tavfService';
import { apiLimiter } from '../middleware/rateLimiter';

// Mock the entire service module
jest.mock('../services/tavfService');
jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'test@example.com',
      roles: ['EVENT_CREATOR'],
      rawClaims: {},
    };
    next();
  },
}));

const app = express();
app.use(apiLimiter);
app.use(express.json());
app.use('/api', authenticate);
app.use('/api/tavf', tavfRouter);

const POSTING: tavfService.TavfPosting = {
  posting_id: 'p-1111',
  tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
  guide_member_id: '11111111-1111-4111-8111-111111111111',
  event_date: '2025-07-04',
  location: 'Rocky Mountain National Park',
  capacity: 2,
  species: 'Trout',
  description: 'A great day on the water',
  status: 'open',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const APPLICATION: tavfService.TavfApplication = {
  application_id: 'a-3333',
  tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
  posting_id: 'p-1111',
  vet_member_id: 'v-4444',
  notes: 'Looking forward to it',
  status: 'pending',
  applied_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MATCH: tavfService.TavfMatch = {
  match_id: 'm-5555',
  tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
  posting_id: 'p-1111',
  application_id: 'a-3333',
  matched_by: 'admin-6666',
  matched_at: new Date().toISOString(),
  status: 'confirmed',
  notes: null,
};

describe('TaVF Posting routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET /api/tavf/postings returns a list', async () => {
    (tavfService.listPostings as jest.Mock).mockResolvedValue([POSTING]);
    const res = await request(app).get('/api/tavf/postings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([POSTING]);
    expect(tavfService.listPostings).toHaveBeenCalledWith({});
  });

  it('GET /api/tavf/postings?status=open filters by status', async () => {
    (tavfService.listPostings as jest.Mock).mockResolvedValue([POSTING]);
    const res = await request(app).get('/api/tavf/postings?status=open');
    expect(res.status).toBe(200);
    expect(tavfService.listPostings).toHaveBeenCalledWith({ status: 'open' });
  });

  it('GET /api/tavf/postings/:id returns a posting', async () => {
    (tavfService.getPosting as jest.Mock).mockResolvedValue(POSTING);
    const res = await request(app).get('/api/tavf/postings/p-1111');
    expect(res.status).toBe(200);
    expect(res.body.posting_id).toBe('p-1111');
  });

  it('GET /api/tavf/postings/:id returns 404 when not found', async () => {
    (tavfService.getPosting as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/tavf/postings/no-such-id');
    expect(res.status).toBe(404);
  });

  it('POST /api/tavf/postings creates a posting', async () => {
    (tavfService.createPosting as jest.Mock).mockResolvedValue(POSTING);
    const res = await request(app)
      .post('/api/tavf/postings')
      .send({
        guide_member_id: '11111111-1111-4111-8111-111111111111',
        event_date: '2025-07-04',
        location: 'Rocky Mountain National Park',
        capacity: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.posting_id).toBe('p-1111');
  });

  it('POST /api/tavf/postings returns 400 when required fields missing', async () => {
    const res = await request(app)
      .post('/api/tavf/postings')
      .send({ guide_member_id: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/tavf/postings/:id updates a posting', async () => {
    const updated = { ...POSTING, location: 'New Location' };
    (tavfService.updatePosting as jest.Mock).mockResolvedValue(updated);
    const res = await request(app)
      .patch('/api/tavf/postings/p-1111')
      .send({ location: 'New Location' });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('New Location');
  });

  it('PATCH /api/tavf/postings/:id returns 404 when not found', async () => {
    (tavfService.updatePosting as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .patch('/api/tavf/postings/no-id')
      .send({ location: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tavf/postings/:id deletes a posting', async () => {
    (tavfService.deletePosting as jest.Mock).mockResolvedValue(true);
    const res = await request(app).delete('/api/tavf/postings/p-1111');
    expect(res.status).toBe(204);
  });

  it('DELETE /api/tavf/postings/:id returns 404 when not found', async () => {
    (tavfService.deletePosting as jest.Mock).mockResolvedValue(false);
    const res = await request(app).delete('/api/tavf/postings/no-id');
    expect(res.status).toBe(404);
  });
});

describe('TaVF Application routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET /api/tavf/postings/:id/applications returns applications', async () => {
    (tavfService.listApplicationsForPosting as jest.Mock).mockResolvedValue([APPLICATION]);
    const res = await request(app).get('/api/tavf/postings/p-1111/applications');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([APPLICATION]);
  });

  it('POST /api/tavf/postings/:id/applications creates an application', async () => {
    (tavfService.createApplication as jest.Mock).mockResolvedValue(APPLICATION);
    const res = await request(app)
      .post('/api/tavf/postings/p-1111/applications')
      .send({ vet_member_id: 'v-4444', notes: 'Looking forward to it' });
    expect(res.status).toBe(201);
    expect(res.body.application_id).toBe('a-3333');
  });

  it('POST /api/tavf/postings/:id/applications returns 400 when vet_member_id missing', async () => {
    const res = await request(app)
      .post('/api/tavf/postings/p-1111/applications')
      .send({});
    expect(res.status).toBe(400);
  });

  it('GET /api/tavf/applications/:id returns an application', async () => {
    (tavfService.getApplication as jest.Mock).mockResolvedValue(APPLICATION);
    const res = await request(app).get('/api/tavf/applications/a-3333');
    expect(res.status).toBe(200);
    expect(res.body.application_id).toBe('a-3333');
  });

  it('GET /api/tavf/applications/:id returns 404 when not found', async () => {
    (tavfService.getApplication as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/tavf/applications/no-id');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/tavf/applications/:id/status updates status', async () => {
    const matched = { ...APPLICATION, status: 'matched' as tavfService.ApplicationStatus };
    (tavfService.updateApplicationStatus as jest.Mock).mockResolvedValue(matched);
    const res = await request(app)
      .patch('/api/tavf/applications/a-3333/status')
      .send({ status: 'matched' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('matched');
  });
});

describe('TaVF Match routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET /api/tavf/matches returns flattened matches across postings', async () => {
    (tavfService.listPostings as jest.Mock).mockResolvedValue([
      { ...POSTING, posting_id: 'p-1111' },
      { ...POSTING, posting_id: 'p-2222' },
    ]);
    (tavfService.listMatchesForPosting as jest.Mock)
      .mockResolvedValueOnce([MATCH])
      .mockResolvedValueOnce([{ ...MATCH, match_id: 'm-9999', posting_id: 'p-2222' }]);

    const res = await request(app).get('/api/tavf/matches');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(tavfService.listPostings).toHaveBeenCalledWith();
    expect(tavfService.listMatchesForPosting).toHaveBeenCalledTimes(2);
    expect(tavfService.listMatchesForPosting).toHaveBeenNthCalledWith(1, 'p-1111');
    expect(tavfService.listMatchesForPosting).toHaveBeenNthCalledWith(2, 'p-2222');
  });

  it('GET /api/tavf/postings/:id/matches returns matches', async () => {
    (tavfService.listMatchesForPosting as jest.Mock).mockResolvedValue([MATCH]);
    const res = await request(app).get('/api/tavf/postings/p-1111/matches');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([MATCH]);
  });

  it('POST /api/tavf/matches creates a match', async () => {
    (tavfService.createMatch as jest.Mock).mockResolvedValue(MATCH);
    const res = await request(app)
      .post('/api/tavf/matches')
      .send({ posting_id: 'p-1111', application_id: 'a-3333', matched_by: 'admin-6666' });
    expect(res.status).toBe(201);
    expect(res.body.match_id).toBe('m-5555');
  });

  it('POST /api/tavf/matches returns 400 when required fields missing', async () => {
    const res = await request(app)
      .post('/api/tavf/matches')
      .send({ posting_id: 'p-1111' });
    expect(res.status).toBe(400);
  });

  it('GET /api/tavf/matches/:id returns a match', async () => {
    (tavfService.getMatch as jest.Mock).mockResolvedValue(MATCH);
    const res = await request(app).get('/api/tavf/matches/m-5555');
    expect(res.status).toBe(200);
    expect(res.body.match_id).toBe('m-5555');
  });

  it('GET /api/tavf/matches/:id returns 404 when not found', async () => {
    (tavfService.getMatch as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/tavf/matches/no-id');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tavf/matches/:id cancels a match', async () => {
    const cancelled = { ...MATCH, status: 'cancelled' as tavfService.MatchStatus };
    (tavfService.cancelMatch as jest.Mock).mockResolvedValue(cancelled);
    const res = await request(app).delete('/api/tavf/matches/m-5555');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('DELETE /api/tavf/matches/:id returns 404 when not found', async () => {
    (tavfService.cancelMatch as jest.Mock).mockResolvedValue(null);
    const res = await request(app).delete('/api/tavf/matches/no-id');
    expect(res.status).toBe(404);
  });
});
