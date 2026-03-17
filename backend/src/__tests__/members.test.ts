/**
 * Unit tests for Members routes.
 */

import request from 'supertest';
import express from 'express';
import membersRouter from '../routes/members';

// Mock DB
jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n?: number) => `NVarChar(${n ?? 'MAX'})`),
    Int: 'Int',
    Bit: 'Bit',
    DateTime: 'DateTime',
    MAX: 'MAX',
  },
}));

// Mock member service
jest.mock('../services/memberService', () => ({
  listMembers: jest.fn(),
  getMemberById: jest.fn(),
  createMember: jest.fn(),
  updateMember: jest.fn(),
  deactivateMember: jest.fn(),
}));

// Mock group service
jest.mock('../services/groupService', () => ({
  getMemberGroups: jest.fn().mockResolvedValue([]),
}));

// Mock notifications
jest.mock('../services/notifications', () => ({
  notificationService: {
    writeSmsConsentLog: jest.fn().mockResolvedValue(undefined),
    sendSms: jest.fn().mockResolvedValue(undefined),
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

const { listMembers, getMemberById, createMember, updateMember, deactivateMember } =
  require('../services/memberService');

const app = express();
app.use(express.json());
app.use('/api/v1/members', membersRouter);

const SAMPLE_MEMBER = {
  member_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
  mobile_phone: null,
  is_active: true,
  sms_opt_in: false,
};

describe('Members routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/v1/members', () => {
    it('returns a list of members', async () => {
      listMembers.mockResolvedValue({ members: [SAMPLE_MEMBER], total: 1 });
      const res = await request(app).get('/api/v1/members');
      expect(res.status).toBe(200);
      expect(res.body.members).toHaveLength(1);
    });

    it('supports search query param', async () => {
      listMembers.mockResolvedValue({ members: [], total: 0 });
      const res = await request(app).get('/api/v1/members?search=John');
      expect(res.status).toBe(200);
      expect(listMembers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'John' })
      );
    });
  });

  describe('GET /api/v1/members/:id', () => {
    it('returns a member by ID', async () => {
      getMemberById.mockResolvedValue(SAMPLE_MEMBER);
      const res = await request(app).get(`/api/v1/members/${SAMPLE_MEMBER.member_id}`);
      expect(res.status).toBe(200);
      expect(res.body.member_id).toBe(SAMPLE_MEMBER.member_id);
    });

    it('returns 404 when member not found', async () => {
      getMemberById.mockResolvedValue(null);
      const res = await request(app).get('/api/v1/members/no-such-id');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/members', () => {
    it('creates a member and returns 201', async () => {
      createMember.mockResolvedValue(SAMPLE_MEMBER);
      const res = await request(app).post('/api/v1/members').send({
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@example.com',
      });
      expect(res.status).toBe(201);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app).post('/api/v1/members').send({ first_name: 'John' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/members/:id', () => {
    it('updates a member', async () => {
      updateMember.mockResolvedValue({ ...SAMPLE_MEMBER, first_name: 'Jane' });
      const res = await request(app)
        .patch(`/api/v1/members/${SAMPLE_MEMBER.member_id}`)
        .send({ first_name: 'Jane' });
      expect(res.status).toBe(200);
      expect(res.body.first_name).toBe('Jane');
    });

    it('returns 404 when member not found', async () => {
      updateMember.mockResolvedValue(null);
      const res = await request(app)
        .patch('/api/v1/members/no-id')
        .send({ first_name: 'Jane' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/members/:id', () => {
    it('deactivates a member', async () => {
      deactivateMember.mockResolvedValue(SAMPLE_MEMBER);
      const res = await request(app).delete(`/api/v1/members/${SAMPLE_MEMBER.member_id}`);
      expect(res.status).toBe(200);
    });

    it('returns 404 when member not found', async () => {
      deactivateMember.mockResolvedValue(null);
      const res = await request(app).delete('/api/v1/members/no-id');
      expect(res.status).toBe(404);
    });
  });
});
