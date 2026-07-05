import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      passkeys: { findFirst: vi.fn(), findMany: vi.fn() },
      verificationTokens: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'updated' }]),
        })),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  isNull: vi.fn((a: unknown) => ({ op: 'isNull', a })),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  passkeys: {
    id: 'passkeys.id', userId: 'passkeys.userId', credentialId: 'passkeys.credentialId',
    publicKey: 'passkeys.publicKey', counter: 'passkeys.counter', transports: 'passkeys.transports',
  },
  users: { id: 'users.id', email: 'users.email' },
  verificationTokens: {
    id: 'vt.id', userId: 'vt.userId', tokenHash: 'vt.tokenHash', tokenPrefix: 'vt.tokenPrefix',
    type: 'vt.type', expiresAt: 'vt.expiresAt', usedAt: 'vt.usedAt', metadata: 'vt.metadata',
  },
}));
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

const mockGenAuthOptions = vi.fn();
const mockVerifyAuthResponse = vi.fn();
vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: (...args: unknown[]) => mockGenAuthOptions(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthResponse(...args),
}));

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  generateToken: vi.fn((prefix: string) => ({
    token: `${prefix}_rawtoken`,
    hash: `hashed_${prefix}_rawtoken`,
    tokenPrefix: `${prefix}_rawt`,
  })),
}));

const mockSendEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/email-service', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  resolveAppUrl: () => 'https://app.pagespace.ai',
}));

vi.mock('../../email-templates/StepUpConfirmationEmail', () => ({
  StepUpConfirmationEmail: () => null,
}));

import { db } from '@pagespace/db/db';
import {
  beginWebauthnStepUp,
  verifyWebauthnStepUp,
  consumeStepUpGrant,
  requestMagicLinkStepUp,
  completeMagicLinkStepUp,
} from '../step-up-service';
import { computeActionBindingHash } from '../step-up-decisions';

type MockFn = ReturnType<typeof vi.fn>;
type MockDb = {
  query: {
    users: { findFirst: MockFn };
    passkeys: { findFirst: MockFn; findMany: MockFn };
    verificationTokens: { findFirst: MockFn };
  };
  insert: MockFn;
  update: MockFn;
  delete: MockFn;
};
const mockDb = db as unknown as MockDb;

describe('step-up-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'updated' }]) }),
      }),
    });
    mockDb.delete.mockReturnValue({ where: vi.fn() });
    mockGenAuthOptions.mockResolvedValue({ challenge: 'server-challenge' });
  });

  describe('beginWebauthnStepUp', () => {
    it('returns NO_PASSKEY when the user has no registered passkey', async () => {
      mockDb.query.passkeys.findMany.mockResolvedValue([]);

      const result = await beginWebauthnStepUp({ userId: 'user-1', actionBinding: { name: 'My Token' } });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NO_PASSKEY');
    });

    it('returns options + challengeId when the user has a passkey', async () => {
      mockDb.query.passkeys.findMany.mockResolvedValue([{ credentialId: 'cred-1', transports: null }]);

      const result = await beginWebauthnStepUp({ userId: 'user-1', actionBinding: { name: 'My Token' } });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.options.challenge).toBe('server-challenge');
        expect(result.data.challengeId).toBe('test-cuid');
      }
    });
  });

  describe('verifyWebauthnStepUp', () => {
    const actionBinding = { name: 'My Token' };
    const actionBindingHash = computeActionBindingHash(actionBinding);

    it('rejects when no matching challenge exists', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue(undefined);

      const result = await verifyWebauthnStepUp({
        userId: 'user-1',
        response: { id: 'cred-1' },
        expectedChallenge: 'server-challenge',
        actionBinding,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STEP_UP_INVALID');
    });

    it('rejects when the credential belongs to a different user', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue({
        id: 'challenge-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ actionBindingHash }),
      });
      mockDb.query.passkeys.findFirst.mockResolvedValue({
        id: 'passkey-1',
        userId: 'someone-else',
        credentialId: 'cred-1',
        publicKey: Buffer.from('pk').toString('base64url'),
        counter: 0,
      });

      const result = await verifyWebauthnStepUp({
        userId: 'user-1',
        response: { id: 'cred-1' },
        expectedChallenge: 'server-challenge',
        actionBinding,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STEP_UP_INVALID');
    });

    it('mints a step-up grant token on a valid, correctly-bound assertion', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue({
        id: 'challenge-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ actionBindingHash }),
      });
      mockDb.query.passkeys.findFirst.mockResolvedValue({
        id: 'passkey-1',
        userId: 'user-1',
        credentialId: 'cred-1',
        publicKey: Buffer.from('pk').toString('base64url'),
        counter: 0,
      });
      mockVerifyAuthResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      });

      const result = await verifyWebauthnStepUp({
        userId: 'user-1',
        response: { id: 'cred-1' },
        expectedChallenge: 'server-challenge',
        actionBinding,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.stepUpToken).toBe('ps_stepup_rawtoken');
    });

    it('rejects when the crypto assertion itself fails to verify', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue({
        id: 'challenge-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ actionBindingHash }),
      });
      mockDb.query.passkeys.findFirst.mockResolvedValue({
        id: 'passkey-1',
        userId: 'user-1',
        credentialId: 'cred-1',
        publicKey: Buffer.from('pk').toString('base64url'),
        counter: 0,
      });
      mockVerifyAuthResponse.mockResolvedValue({ verified: false });

      const result = await verifyWebauthnStepUp({
        userId: 'user-1',
        response: { id: 'cred-1' },
        expectedChallenge: 'server-challenge',
        actionBinding,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STEP_UP_INVALID');
    });
  });

  describe('consumeStepUpGrant', () => {
    const actionBinding = { clientId: 'cli-1' };
    const actionBindingHash = computeActionBindingHash(actionBinding);

    it('rejects when no grant exists', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue(undefined);

      const result = await consumeStepUpGrant({ userId: 'user-1', token: 'ps_stepup_x', actionBinding });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STEP_UP_REQUIRED');
    });

    it('accepts and consumes a valid, correctly-bound, same-user grant', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue({
        id: 'grant-1',
        userId: 'user-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ actionBindingHash }),
      });

      const result = await consumeStepUpGrant({ userId: 'user-1', token: 'ps_stepup_x', actionBinding });

      expect(result.ok).toBe(true);
    });

    it('rejects a grant belonging to a different user', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValue({
        id: 'grant-1',
        userId: 'someone-else',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ actionBindingHash }),
      });

      const result = await consumeStepUpGrant({ userId: 'user-1', token: 'ps_stepup_x', actionBinding });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STEP_UP_REQUIRED');
    });
  });

  describe('requestMagicLinkStepUp', () => {
    it('returns USER_NOT_FOUND when the user does not exist', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(undefined);

      const result = await requestMagicLinkStepUp({ userId: 'ghost', actionBinding: { clientId: 'cli-1' } });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('sends a step-up confirmation email to the user\'s own registered address', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });

      const result = await requestMagicLinkStepUp({ userId: 'user-1', actionBinding: { clientId: 'cli-1' } });

      expect(result.ok).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'user@example.com' }),
      );
    });
  });

  describe('completeMagicLinkStepUp', () => {
    const actionBindingHash = computeActionBindingHash({ clientId: 'cli-1' });

    it('rejects metadata from an ordinary sign-in magic link', async () => {
      const result = await completeMagicLinkStepUp({
        userId: 'user-1',
        metadata: JSON.stringify({ platform: 'desktop' }),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STEP_UP_INVALID');
    });

    it('mints a step-up grant token for step-up metadata', async () => {
      const result = await completeMagicLinkStepUp({
        userId: 'user-1',
        metadata: JSON.stringify({ purpose: 'step_up', actionBindingHash }),
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.stepUpToken).toBe('ps_stepup_rawtoken');
    });
  });
});
