/**
 * Unit tests for Events routes.
 */

import request from 'supertest';
import express from 'express';
import eventsRouter from '../routes/events';

// Mock DB
jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n?: number) => `NVarChar(${n ?? 'MAX'})`),
    Int: 'Int',
    Bit: 'Bit',
    DateTime: 'DateTime',
    Date: 'Date',
    MAX: 'MAX',
  },
}));

// Mock notifications so no real sends are attempted
jest.mock('../services/notifications', () => ({
  sendEventPublishedNotification: jest.fn().mockResolvedValue(undefined),
  sendEventCancelledNotification: jest.fn().mockResolvedValue(undefined),
  notificationService: {
    sendEmail: jest.fn(),
    sendSms: jest.fn(),
    writeSmsConsentLog: jest.fn(),
  },
}));

const { getPool } = require('../db');

const app = express();
app.use(express.json());
app.use('/api/v1/events', eventsRouter);

// Sample event row returned from DB
const SAMPLE_EVENT = {
  event_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  title: 'Test Event',
  event_date: new Date('2025-06-15'),
  location: 'Rocky Mountain NP',
  description: 'A great day out',
  status: 'draft',
  capacity: 20,
  yes_count: 5,
  target_count: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function makeMockPool(recordset: unknown[] = [], rowsAffected: number[] = [1]) {
  const queryMock = jest.fn().mockResolvedValue({ recordset, rowsAffected });
  const requestMock = jest.fn().mockReturnValue({
    input: jest.fn().mockReturnThis(),
    query: queryMock,
  });
  return { request: requestMock };
}

describe('Events routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/v1/events', () => {
    it('returns a list of events', async () => {
      getPool.mockResolvedValue(makeMockPool([SAMPLE_EVENT]));
      const res = await request(app).get('/api/v1/events');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('supports filtering by status', async () => {
      getPool.mockResolvedValue(makeMockPool([SAMPLE_EVENT]));
      const res = await request(app).get('/api/v1/events?status=draft');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/events', () => {
    it('creates an event and returns 201', async () => {
      getPool.mockResolvedValue(makeMockPool([SAMPLE_EVENT]));
      const res = await request(app)
        .post('/api/v1/events')
        .send({ title: 'New Event', event_date: '2025-07-01', location: 'Denver' });
      expect(res.status).toBe(201);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/v1/events')
        .send({ location: 'Denver' });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/v1/events/:id/status', () => {
    it('returns 400 when status is missing', async () => {
      const res = await request(app)
        .put(`/api/v1/events/${SAMPLE_EVENT.event_id}/status`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 when event is not found', async () => {
      getPool.mockResolvedValue(makeMockPool([]));
      const res = await request(app)
        .put(`/api/v1/events/${SAMPLE_EVENT.event_id}/status`)
        .send({ status: 'published' });
      expect(res.status).toBe(404);
    });

    it('returns 409 when transition is not allowed', async () => {
      getPool.mockResolvedValue(makeMockPool([{ ...SAMPLE_EVENT, status: 'cancelled' }]));
      const res = await request(app)
        .put(`/api/v1/events/${SAMPLE_EVENT.event_id}/status`)
        .send({ status: 'published' });
      expect(res.status).toBe(409);
    });

    it('successfully transitions from draft to published', async () => {
      const pool = {
        request: jest.fn()
          .mockReturnValueOnce({
            input: jest.fn().mockReturnThis(),
            query: jest.fn().mockResolvedValue({
              recordset: [{ ...SAMPLE_EVENT, status: 'draft' }],
            }),
          })
          .mockReturnValueOnce({
            input: jest.fn().mockReturnThis(),
            query: jest.fn().mockResolvedValue({
              recordset: [{ ...SAMPLE_EVENT, status: 'published' }],
            }),
          }),
      };
      getPool.mockResolvedValue(pool);

      const res = await request(app)
        .put(`/api/v1/events/${SAMPLE_EVENT.event_id}/status`)
        .send({ status: 'published' });
      expect(res.status).toBe(200);
    });
  });
});
