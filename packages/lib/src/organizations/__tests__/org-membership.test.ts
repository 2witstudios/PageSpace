import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/db before importing the module under test
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      orgMembers: { findFirst: vi.fn() },
      orgInvitations: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    transaction: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  orgMembers: {
    orgId: 'orgMembers.orgId',
    userId: 'orgMembers.userId',
    id: 'orgMembers.id',
  },
  orgInvitations: {
    orgId: 'orgInvitations.orgId',
    email: 'orgInvitations.email',
    token: 'orgInvitations.token',
    id: 'orgInvitations.id',
    acceptedAt: 'orgInvitations.acceptedAt',
    expiresAt: 'orgInvitations.expiresAt',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
  },
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  gt: vi.fn((a, b) => ({ op: 'gt', a, b })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-token'),
}));

// Import after mocking
import { db } from '@pagespace/db';
import {
  createInvitation,
  acceptInvitation,
  listPendingInvitations,
  revokeInvitation,
} from '../org-membership';

describe('org-membership', () => {
  const orgId = 'org-1';
  const invitedBy = 'user-inviter';
  const inviteeEmail = 'invitee@example.com';
  const userId = 'user-invitee';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createInvitation
  // ---------------------------------------------------------------------------
  describe('createInvitation', () => {
    const input = { email: inviteeEmail, role: 'MEMBER' as const };

    function mockInsertReturning(returnValue: unknown) {
      const returning = vi.fn().mockResolvedValue([returnValue]);
      const values = vi.fn().mockReturnValue({ returning });
      vi.mocked(db.insert).mockReturnValue({ values } as any);
    }

    function mockUpdateReturning(returnValue: unknown) {
      const returning = vi.fn().mockResolvedValue([returnValue]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      vi.mocked(db.update).mockReturnValue({ set } as any);
    }

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    it('creates a new invitation when no user or prior invitation exists', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(undefined);

      const newInvitation = {
        id: 'inv-1',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER' as const,
        token: 'mock-token',
        expiresAt: futureDate,
        invitedBy,
        acceptedAt: null,
        createdAt: new Date(),
      };
      mockInsertReturning(newInvitation);

      const result = await createInvitation(orgId, invitedBy, input);

      expect(result).toEqual({
        id: 'inv-1',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER',
        token: 'mock-token',
        expiresAt: futureDate,
      });
      expect(db.insert).toHaveBeenCalled();
    });

    it('creates a new invitation for known user who is not a member', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ id: 'existing-user' });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(undefined);

      const newInvitation = {
        id: 'inv-2',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER' as const,
        token: 'mock-token',
        expiresAt: futureDate,
        invitedBy,
        acceptedAt: null,
        createdAt: new Date(),
      };
      mockInsertReturning(newInvitation);

      const result = await createInvitation(orgId, invitedBy, input);

      expect(result.id).toBe('inv-2');
      expect(db.insert).toHaveBeenCalled();
    });

    it('throws when user is already a member of the organization', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ id: 'existing-user' });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue({ id: 'member-1' });

      await expect(createInvitation(orgId, invitedBy, input)).rejects.toThrow(
        'User is already a member of this organization'
      );
    });

    it('throws when an active pending invitation already exists', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue({
        id: 'inv-existing',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER',
        token: 'old-token',
        expiresAt: futureDate,
        acceptedAt: null,
        invitedBy: 'someone',
        createdAt: new Date(),
      });

      await expect(createInvitation(orgId, invitedBy, input)).rejects.toThrow(
        'An invitation has already been sent to this email'
      );
    });

    it('re-invites by updating an expired invitation', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue({
        id: 'inv-expired',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER',
        token: 'old-token',
        expiresAt: pastDate,
        acceptedAt: null,
        invitedBy: 'someone',
        createdAt: new Date(),
      });

      const updatedInvitation = {
        id: 'inv-expired',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER' as const,
        token: 'mock-token',
        expiresAt: futureDate,
        acceptedAt: null,
        invitedBy,
        createdAt: new Date(),
      };
      mockUpdateReturning(updatedInvitation);

      const result = await createInvitation(orgId, invitedBy, input);

      expect(result.id).toBe('inv-expired');
      expect(result.token).toBe('mock-token');
      expect(db.update).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('re-invites by updating a previously accepted invitation', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue({
        id: 'inv-accepted',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER',
        token: 'old-token',
        expiresAt: futureDate,
        acceptedAt: new Date(),
        invitedBy: 'someone',
        createdAt: new Date(),
      });

      const updatedInvitation = {
        id: 'inv-accepted',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER' as const,
        token: 'mock-token',
        expiresAt: futureDate,
        acceptedAt: null,
        invitedBy,
        createdAt: new Date(),
      };
      mockUpdateReturning(updatedInvitation);

      const result = await createInvitation(orgId, invitedBy, input);

      expect(result.id).toBe('inv-accepted');
      expect(db.update).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('defaults role to MEMBER when not specified', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(undefined);

      const newInvitation = {
        id: 'inv-default-role',
        orgId,
        email: inviteeEmail,
        role: 'MEMBER' as const,
        token: 'mock-token',
        expiresAt: futureDate,
        invitedBy,
        acceptedAt: null,
        createdAt: new Date(),
      };
      mockInsertReturning(newInvitation);

      const result = await createInvitation(orgId, invitedBy, { email: inviteeEmail });

      expect(result.role).toBe('MEMBER');
    });

    it('uses ADMIN role when specified', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(undefined);

      const newInvitation = {
        id: 'inv-admin',
        orgId,
        email: inviteeEmail,
        role: 'ADMIN' as const,
        token: 'mock-token',
        expiresAt: futureDate,
        invitedBy,
        acceptedAt: null,
        createdAt: new Date(),
      };
      mockInsertReturning(newInvitation);

      const result = await createInvitation(orgId, invitedBy, {
        email: inviteeEmail,
        role: 'ADMIN',
      });

      expect(result.role).toBe('ADMIN');
    });

    it('maps InvitationResult correctly via toInvitationResult', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(undefined);

      const expiresAt = new Date('2026-04-01T00:00:00Z');
      const newInvitation = {
        id: 'inv-map',
        orgId: 'org-map',
        email: 'map@example.com',
        role: 'ADMIN' as const,
        token: 'mock-token',
        expiresAt,
        invitedBy,
        acceptedAt: null,
        createdAt: new Date(),
      };
      mockInsertReturning(newInvitation);

      const result = await createInvitation('org-map', invitedBy, {
        email: 'map@example.com',
        role: 'ADMIN',
      });

      expect(result).toEqual({
        id: 'inv-map',
        orgId: 'org-map',
        email: 'map@example.com',
        role: 'ADMIN',
        token: 'mock-token',
        expiresAt,
      });
      // Should NOT include invitedBy, acceptedAt, createdAt
      expect(result).not.toHaveProperty('invitedBy');
      expect(result).not.toHaveProperty('acceptedAt');
      expect(result).not.toHaveProperty('createdAt');
    });
  });

  // ---------------------------------------------------------------------------
  // acceptInvitation
  // ---------------------------------------------------------------------------
  describe('acceptInvitation', () => {
    const token = 'valid-token';
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const validInvitation = {
      id: 'inv-1',
      orgId,
      email: inviteeEmail,
      role: 'MEMBER' as const,
      token,
      expiresAt: futureDate,
      acceptedAt: null,
      invitedBy,
      createdAt: new Date(),
    };

    function setupTransactionMock() {
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        const txInsert = vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        });
        const txUpdate = vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        });
        const tx = { insert: txInsert, update: txUpdate };
        return fn(tx as any);
      });
    }

    it('accepts a valid invitation and returns the orgId', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);
      setupTransactionMock();

      const result = await acceptInvitation(token, userId);

      expect(result).toEqual({ orgId });
      expect(db.transaction).toHaveBeenCalled();
    });

    it('throws when invitation token is not found', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(undefined);

      await expect(acceptInvitation('bad-token', userId)).rejects.toThrow(
        'Invitation not found'
      );
    });

    it('throws when invitation has already been accepted', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue({
        ...validInvitation,
        acceptedAt: new Date(),
      });

      await expect(acceptInvitation(token, userId)).rejects.toThrow(
        'Invitation has already been accepted'
      );
    });

    it('throws when invitation has expired', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue({
        ...validInvitation,
        expiresAt: pastDate,
      });

      await expect(acceptInvitation(token, userId)).rejects.toThrow(
        'Invitation has expired'
      );
    });

    it('throws when user is not found', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      await expect(acceptInvitation(token, userId)).rejects.toThrow(
        'This invitation was sent to a different email address'
      );
    });

    it('throws when user email does not match invitation email', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        email: 'different@example.com',
      });

      await expect(acceptInvitation(token, userId)).rejects.toThrow(
        'This invitation was sent to a different email address'
      );
    });

    it('throws when user is already a member of the organization', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue({ id: 'member-existing' });

      await expect(acceptInvitation(token, userId)).rejects.toThrow(
        'You are already a member of this organization'
      );
    });

    it('inserts orgMember and updates invitation acceptedAt inside a transaction', async () => {
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);

      let capturedTx: any;
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        const txInsertValues = vi.fn().mockResolvedValue(undefined);
        const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
        const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
        const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
        const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
        capturedTx = { insert: txInsert, update: txUpdate };
        return fn(capturedTx as any);
      });

      await acceptInvitation(token, userId);

      expect(capturedTx.insert).toHaveBeenCalled();
      expect(capturedTx.update).toHaveBeenCalled();
    });

    it('downgrades OWNER role to MEMBER when inserting org member', async () => {
      const ownerInvitation = {
        ...validInvitation,
        role: 'OWNER' as const,
      };
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(ownerInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);

      let capturedValues: any;
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        const txInsertValues = vi.fn().mockImplementation((vals) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        });
        const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
        const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
        const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
        const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
        return fn({ insert: txInsert, update: txUpdate } as any);
      });

      await acceptInvitation(token, userId);

      expect(capturedValues.role).toBe('MEMBER');
    });

    it('preserves ADMIN role when inserting org member', async () => {
      const adminInvitation = {
        ...validInvitation,
        role: 'ADMIN' as const,
      };
      vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(adminInvitation);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
      vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);

      let capturedValues: any;
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        const txInsertValues = vi.fn().mockImplementation((vals) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        });
        const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
        const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
        const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
        const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
        return fn({ insert: txInsert, update: txUpdate } as any);
      });

      await acceptInvitation(token, userId);

      expect(capturedValues.role).toBe('ADMIN');
    });

    // -------------------------------------------------------------------------
    // expectedOrgId validation
    // -------------------------------------------------------------------------
    describe('expectedOrgId validation', () => {
      it('succeeds when expectedOrgId matches invitation orgId', async () => {
        vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
        vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
        vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);
        setupTransactionMock();

        const result = await acceptInvitation(token, userId, orgId);

        expect(result).toEqual({ orgId });
      });

      it('throws when expectedOrgId does not match invitation orgId', async () => {
        vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);

        await expect(
          acceptInvitation(token, userId, 'wrong-org-id')
        ).rejects.toThrow('Invitation not found');
      });

      it('succeeds when expectedOrgId is undefined (backwards compatibility)', async () => {
        vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
        vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
        vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);
        setupTransactionMock();

        const result = await acceptInvitation(token, userId, undefined);

        expect(result).toEqual({ orgId });
      });

      it('succeeds when expectedOrgId is empty string (falsy, skips check)', async () => {
        vi.mocked(db.query.orgInvitations.findFirst).mockResolvedValue(validInvitation);
        vi.mocked(db.query.users.findFirst).mockResolvedValue({ email: inviteeEmail });
        vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);
        setupTransactionMock();

        const result = await acceptInvitation(token, userId, '');

        expect(result).toEqual({ orgId });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // listPendingInvitations
  // ---------------------------------------------------------------------------
  describe('listPendingInvitations', () => {
    it('returns pending invitations from the database', async () => {
      const pendingInvitations = [
        {
          id: 'inv-1',
          orgId,
          email: 'a@example.com',
          role: 'MEMBER',
          token: 'tok-1',
          expiresAt: new Date(Date.now() + 86400000),
          acceptedAt: null,
          invitedBy,
          createdAt: new Date(),
        },
        {
          id: 'inv-2',
          orgId,
          email: 'b@example.com',
          role: 'ADMIN',
          token: 'tok-2',
          expiresAt: new Date(Date.now() + 86400000),
          acceptedAt: null,
          invitedBy,
          createdAt: new Date(),
        },
      ];
      vi.mocked(db.query.orgInvitations.findMany).mockResolvedValue(pendingInvitations);

      const result = await listPendingInvitations(orgId);

      expect(result).toEqual(pendingInvitations);
      expect(result).toHaveLength(2);
      expect(db.query.orgInvitations.findMany).toHaveBeenCalled();
    });

    it('returns an empty array when no pending invitations exist', async () => {
      vi.mocked(db.query.orgInvitations.findMany).mockResolvedValue([]);

      const result = await listPendingInvitations(orgId);

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // revokeInvitation
  // ---------------------------------------------------------------------------
  describe('revokeInvitation', () => {
    it('deletes the invitation by id', async () => {
      const where = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.delete).mockReturnValue({ where } as any);

      await revokeInvitation('inv-to-revoke');

      expect(db.delete).toHaveBeenCalled();
      expect(where).toHaveBeenCalled();
    });

    it('does not throw when invitation id does not exist', async () => {
      const where = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.delete).mockReturnValue({ where } as any);

      await expect(revokeInvitation('non-existent')).resolves.toBeUndefined();
    });
  });
});
