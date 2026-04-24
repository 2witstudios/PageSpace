/**
 * @scaffold - ORM chain mocks present (update().set().where().returning(),
 * delete().where().returning(), insert().values()).
 * Pending passkey-repository seam extraction for full rubric compliance.
 *
 * REVIEW: verifyAuthentication and verifyRegistration tests use
 * mockDb.update.mockReturnValueOnce chains that encode internal update order
 * (challenge mark-used first, then counter/passkey update). These are
 * order-dependent mock ladders tied to implementation sequencing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((a, b) => ({ op: 'eq', a, b }));
  const and = vi.fn((...args: unknown[]) => ({ op: 'and', args }));
  const isNull = vi.fn((a) => ({ op: 'isNull', a }));
  const lt = vi.fn((a, b) => ({ op: 'lt', a, b }));
  const sql = vi.fn();

  return {
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
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'del' }]),
        })),
      })),
      transaction: vi.fn(),
    },
    passkeys: {
      id: 'passkeys.id', userId: 'passkeys.userId', credentialId: 'passkeys.credentialId',
      publicKey: 'passkeys.publicKey', counter: 'passkeys.counter', deviceType: 'passkeys.deviceType',
      backedUp: 'passkeys.backedUp', transports: 'passkeys.transports', name: 'passkeys.name',
      lastUsedAt: 'passkeys.lastUsedAt', createdAt: 'passkeys.createdAt',
    },
    users: {
      id: 'users.id', email: 'users.email', name: 'users.name', suspendedAt: 'users.suspendedAt',
      provider: 'users.provider', role: 'users.role', tokenVersion: 'users.tokenVersion',
      emailVerified: 'users.emailVerified', tosAcceptedAt: 'users.tosAcceptedAt',
    },
    verificationTokens: {
      id: 'vt.id', userId: 'vt.userId', tokenHash: 'vt.tokenHash', tokenPrefix: 'vt.tokenPrefix',
      type: 'vt.type', expiresAt: 'vt.expiresAt', usedAt: 'vt.usedAt', metadata: 'vt.metadata',
    },
    eq, and, isNull, lt, sql,
  };
});

const mockGenRegOptions = vi.fn();
const mockGenAuthOptions = vi.fn();
const mockVerifyRegResponse = vi.fn();
const mockVerifyAuthResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...args: unknown[]) => mockGenRegOptions(...args),
  generateAuthenticationOptions: (...args: unknown[]) => mockGenAuthOptions(...args),
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegResponse(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthResponse(...args),
}));

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  generateToken: vi.fn(() => 'generated-token'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

import { db } from '@pagespace/db';
import {
  PASSKEY_CONFIG,
  generateRegistrationOptions,
  verifyRegistration,
  generateAuthenticationOptions,
  verifyAuthentication,
  listUserPasskeys,
  deletePasskey,
  updatePasskeyName,
  generateRegistrationOptionsForSignup,
  verifySignupRegistration,
} from '../passkey-service';

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
  transaction: MockFn;
};
const mockDb = db as unknown as MockDb;

describe('passkey-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset default mock implementations
    mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'updated' }]),
        }),
      }),
    });
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'del' }]),
      }),
    });
  });

  describe('PASSKEY_CONFIG', () => {
    it('should have expected default values', () => {
      expect(PASSKEY_CONFIG.challengeExpiryMinutes).toBe(5);
      expect(PASSKEY_CONFIG.maxPasskeysPerUser).toBe(10);
      expect(PASSKEY_CONFIG.timeout).toBe(60000);
      expect(PASSKEY_CONFIG.maxNameLength).toBe(255);
      expect(PASSKEY_CONFIG.systemUserId).toBe('system-passkey-auth');
    });
  });

  describe('generateRegistrationOptions', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await generateRegistrationOptions({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return USER_NOT_FOUND when user does not exist', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);

      const result = await generateRegistrationOptions({ userId: 'user-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return USER_SUSPENDED when user is suspended', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1', email: 'a@b.com', name: 'Test', suspendedAt: new Date(),
      });

      const result = await generateRegistrationOptions({ userId: 'user-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('USER_SUSPENDED');
    });

    it('should return MAX_PASSKEYS_REACHED when at limit', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1', email: 'a@b.com', name: 'Test', suspendedAt: null,
      });
      mockDb.query.passkeys.findMany.mockResolvedValueOnce(
        Array(10).fill({ credentialId: 'cred', transports: [] })
      );

      const result = await generateRegistrationOptions({ userId: 'user-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MAX_PASSKEYS_REACHED');
    });

    it('should return options on success', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1', email: 'a@b.com', name: 'Test', suspendedAt: null,
      });
      mockDb.query.passkeys.findMany.mockResolvedValueOnce([]);
      mockGenRegOptions.mockResolvedValueOnce({ challenge: 'challenge123', rp: {} });

      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateRegistrationOptions({ userId: 'user-1' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.options.challenge).toBe('challenge123');
    });

    // WebAuthn L3 hint — tells the browser to prefer the OS platform authenticator
    // (Touch ID / Windows Hello) over the cross-device QR flow, while still allowing
    // the user to pick "use a different device" in the native picker.
    it('generateRegistrationOptions_default_includesClientDeviceHint', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1', email: 'a@b.com', name: 'Test', suspendedAt: null,
      });
      mockDb.query.passkeys.findMany.mockResolvedValueOnce([]);
      mockGenRegOptions.mockResolvedValueOnce({ challenge: 'challenge123', rp: {} });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateRegistrationOptions({ userId: 'user-1' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data.options as { hints?: readonly string[] }).hints).toEqual(['client-device']);
      }
    });

    // Portability constraint: we must NOT set authenticatorAttachment,
    // because 'platform' would hard-exclude cross-device registration and
    // the user has asked to keep that path open as a fallback.
    it('generateRegistrationOptions_default_omitsAuthenticatorAttachment', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1', email: 'a@b.com', name: 'Test', suspendedAt: null,
      });
      mockDb.query.passkeys.findMany.mockResolvedValueOnce([]);
      mockGenRegOptions.mockResolvedValueOnce({ challenge: 'challenge123', rp: {} });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      await generateRegistrationOptions({ userId: 'user-1' });

      const simpleWebAuthnArgs = mockGenRegOptions.mock.calls[0]?.[0] as {
        authenticatorSelection?: {
          authenticatorAttachment?: string;
          residentKey?: string;
          requireResidentKey?: boolean;
          userVerification?: string;
        };
      };
      expect(simpleWebAuthnArgs.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
      expect(simpleWebAuthnArgs.authenticatorSelection?.residentKey).toBe('required');
      expect(simpleWebAuthnArgs.authenticatorSelection?.requireResidentKey).toBe(true);
      expect(simpleWebAuthnArgs.authenticatorSelection?.userVerification).toBe('required');
    });
  });

  describe('verifyRegistration', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await verifyRegistration({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return CHALLENGE_NOT_FOUND when challenge missing', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce(null);

      const result = await verifyRegistration({
        userId: 'user-1', response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CHALLENGE_NOT_FOUND');
    });

    it('should return CHALLENGE_ALREADY_USED when already used', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
      });

      const result = await verifyRegistration({
        userId: 'user-1', response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CHALLENGE_ALREADY_USED');
    });

    it('should return CHALLENGE_EXPIRED when expired', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() - 60000),
      });

      const result = await verifyRegistration({
        userId: 'user-1', response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CHALLENGE_EXPIRED');
    });

    it('should return CHALLENGE_ALREADY_USED on atomic update race', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await verifyRegistration({
        userId: 'user-1', response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CHALLENGE_ALREADY_USED');
    });

    it('should return VERIFICATION_FAILED when webauthn throws', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
          }),
        }),
      });
      mockVerifyRegResponse.mockRejectedValueOnce(new Error('Bad attestation'));

      const result = await verifyRegistration({
        userId: 'user-1', response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VERIFICATION_FAILED');
      }
    });

    it('should return VERIFICATION_FAILED when not verified', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
          }),
        }),
      });
      mockVerifyRegResponse.mockResolvedValueOnce({ verified: false });

      const result = await verifyRegistration({
        userId: 'user-1', response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VERIFICATION_FAILED');
    });

    it('should return passkeyId on success', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
          }),
        }),
      });
      mockVerifyRegResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: { id: 'cred-id', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await verifyRegistration({
        userId: 'user-1',
        response: { id: 'cred-1', response: { transports: ['internal'] } },
        expectedChallenge: 'ch-1',
        name: 'My Passkey',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.passkeyId).toBe('test-cuid');
    });
  });

  describe('generateAuthenticationOptions', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await generateAuthenticationOptions({ email: 'not-an-email' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should generate options without email (conditional UI) with client-device hints', async () => {
      mockGenAuthOptions.mockResolvedValueOnce({ challenge: 'auth-challenge' });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateAuthenticationOptions({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.options.challenge).toBe('auth-challenge');
        expect(result.data.options.hints).toEqual(['client-device']);
        expect(result.data.challengeId).toBe('test-cuid');
      }
    });

    it('should generate options with email when user exists, including hints', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: 'user-1' });
      mockDb.query.passkeys.findMany.mockResolvedValueOnce([
        { credentialId: 'cred-1', transports: ['internal'] },
      ]);
      mockGenAuthOptions.mockResolvedValueOnce({ challenge: 'auth-challenge' });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateAuthenticationOptions({ email: 'test@example.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.options.hints).toEqual(['client-device']);
      }
    });

    it('given conditional UI (no email), should only delete EXPIRED challenges for the system user', async () => {
      mockGenAuthOptions.mockResolvedValueOnce({ challenge: 'auth-challenge' });
      const whereSpy = vi.fn().mockResolvedValue(undefined);
      mockDb.delete.mockReturnValue({ where: whereSpy });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const before = Date.now();
      const result = await generateAuthenticationOptions({});
      expect(result.ok).toBe(true);

      // The cleanup where() should have been called with an `and(...)` whose
      // args include an `lt(expiresAt, <now>)` predicate — proving concurrent
      // unexpired sessions' challenges are preserved across visitors.
      expect(whereSpy).toHaveBeenCalledTimes(1);
      const andClause = whereSpy.mock.calls[0][0] as { op: string; args: Array<{ op: string; b?: Date }> };
      expect(andClause.op).toBe('and');
      const ltClause = andClause.args.find((p) => p?.op === 'lt');
      expect(ltClause).toBeDefined();
      expect(ltClause?.b).toBeInstanceOf(Date);
      expect(ltClause!.b!.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('given email-scoped flow, should delete ALL unused challenges for that user (no lt clause)', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: 'user-1' });
      mockDb.query.passkeys.findMany.mockResolvedValueOnce([
        { credentialId: 'cred-1', transports: ['internal'] },
      ]);
      mockGenAuthOptions.mockResolvedValueOnce({ challenge: 'auth-challenge' });
      const whereSpy = vi.fn().mockResolvedValue(undefined);
      mockDb.delete.mockReturnValue({ where: whereSpy });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateAuthenticationOptions({ email: 'test@example.com' });
      expect(result.ok).toBe(true);

      expect(whereSpy).toHaveBeenCalledTimes(1);
      const andClause = whereSpy.mock.calls[0][0] as { op: string; args: Array<{ op: string }> };
      expect(andClause.op).toBe('and');
      const ltClause = andClause.args.find((p) => p?.op === 'lt');
      expect(ltClause).toBeUndefined();
    });
  });

  describe('verifyAuthentication', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await verifyAuthentication({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return CREDENTIAL_NOT_FOUND when passkey not found', async () => {
      mockDb.query.passkeys.findFirst.mockResolvedValueOnce(null);

      const result = await verifyAuthentication({
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CREDENTIAL_NOT_FOUND');
    });

    it('should return USER_SUSPENDED when user is suspended', async () => {
      mockDb.query.passkeys.findFirst.mockResolvedValueOnce({
        id: 'pk-1', userId: 'user-1', credentialId: 'cred-1',
        publicKey: 'AQID', counter: 0,
        user: { id: 'user-1', suspendedAt: new Date() },
      });

      const result = await verifyAuthentication({
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('USER_SUSPENDED');
    });

    it('should return CHALLENGE_NOT_FOUND when challenge missing', async () => {
      mockDb.query.passkeys.findFirst.mockResolvedValueOnce({
        id: 'pk-1', userId: 'user-1', credentialId: 'cred-1',
        publicKey: 'AQID', counter: 0,
        user: { id: 'user-1', suspendedAt: null },
      });
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce(null);

      const result = await verifyAuthentication({
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CHALLENGE_NOT_FOUND');
    });

    it('should return COUNTER_REPLAY_DETECTED when counter check fails', async () => {
      mockDb.query.passkeys.findFirst.mockResolvedValueOnce({
        id: 'pk-1', userId: 'user-1', credentialId: 'cred-1',
        publicKey: 'AQID', counter: 5,
        user: { id: 'user-1', suspendedAt: null },
      });
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });

      // First update: mark challenge as used (succeeds)
      // Second update: counter update (fails - replay)
      mockDb.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

      mockVerifyAuthResponse.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: { newCounter: 3 },
      });

      const result = await verifyAuthentication({
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('COUNTER_REPLAY_DETECTED');
    });

    it('should return userId on successful authentication', async () => {
      mockDb.query.passkeys.findFirst.mockResolvedValueOnce({
        id: 'pk-1', userId: 'user-1', credentialId: 'cred-1',
        publicKey: 'AQID', counter: 0,
        user: { id: 'user-1', suspendedAt: null },
      });
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
      });

      mockDb.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'pk-1' }]),
            }),
          }),
        });

      mockVerifyAuthResponse.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      });

      const result = await verifyAuthentication({
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.userId).toBe('user-1');
        expect(result.data.isNewSession).toBe(true);
      }
    });
  });

  describe('listUserPasskeys', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await listUserPasskeys({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return passkeys list', async () => {
      mockDb.query.passkeys.findMany.mockResolvedValueOnce([
        { id: 'pk-1', name: 'Key 1', deviceType: 'multiDevice', backedUp: true, lastUsedAt: new Date(), createdAt: new Date() },
      ]);

      const result = await listUserPasskeys({ userId: 'user-1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.passkeys).toHaveLength(1);
        expect(result.data.passkeys[0].name).toBe('Key 1');
      }
    });
  });

  describe('deletePasskey', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await deletePasskey({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return PASSKEY_NOT_FOUND when not found', async () => {
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deletePasskey({ userId: 'user-1', passkeyId: 'pk-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PASSKEY_NOT_FOUND');
    });

    it('should return deleted: true on success', async () => {
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'pk-1' }]),
        }),
      });

      const result = await deletePasskey({ userId: 'user-1', passkeyId: 'pk-1' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.deleted).toBe(true);
    });
  });

  describe('updatePasskeyName', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await updatePasskeyName({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return PASSKEY_NOT_FOUND when not found', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updatePasskeyName({ userId: 'user-1', passkeyId: 'pk-1', name: 'New Name' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PASSKEY_NOT_FOUND');
    });

    it('should return updated: true on success', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'pk-1' }]),
          }),
        }),
      });

      const result = await updatePasskeyName({ userId: 'user-1', passkeyId: 'pk-1', name: 'New Name' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.updated).toBe(true);
    });
  });

  describe('generateRegistrationOptionsForSignup', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await generateRegistrationOptionsForSignup({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return EMAIL_EXISTS when user already exists', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: 'existing-user' });

      const result = await generateRegistrationOptionsForSignup({
        email: 'existing@example.com', name: 'Test',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EMAIL_EXISTS');
    });

    it('should return options and challengeId on success', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);
      mockGenRegOptions.mockResolvedValueOnce({ challenge: 'signup-challenge' });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateRegistrationOptionsForSignup({
        email: 'new@example.com', name: 'New User',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.options.challenge).toBe('signup-challenge');
        expect(result.data.challengeId).toBe('test-cuid');
      }
    });

    it('generateRegistrationOptionsForSignup_default_includesClientDeviceHint', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);
      mockGenRegOptions.mockResolvedValueOnce({ challenge: 'signup-challenge' });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      const result = await generateRegistrationOptionsForSignup({
        email: 'new@example.com', name: 'New User',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data.options as { hints?: readonly string[] }).hints).toEqual(['client-device']);
      }
    });

    it('generateRegistrationOptionsForSignup_default_omitsAuthenticatorAttachment', async () => {
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);
      mockGenRegOptions.mockResolvedValueOnce({ challenge: 'signup-challenge' });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

      await generateRegistrationOptionsForSignup({
        email: 'new@example.com', name: 'New User',
      });

      const simpleWebAuthnArgs = mockGenRegOptions.mock.calls[0]?.[0] as {
        authenticatorSelection?: {
          authenticatorAttachment?: string;
          residentKey?: string;
          requireResidentKey?: boolean;
          userVerification?: string;
        };
      };
      expect(simpleWebAuthnArgs.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
      expect(simpleWebAuthnArgs.authenticatorSelection?.residentKey).toBe('required');
      expect(simpleWebAuthnArgs.authenticatorSelection?.requireResidentKey).toBe(true);
      expect(simpleWebAuthnArgs.authenticatorSelection?.userVerification).toBe('required');
    });
  });

  describe('verifySignupRegistration', () => {
    it('should return VALIDATION_FAILED for invalid input', async () => {
      const result = await verifySignupRegistration({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return CHALLENGE_NOT_FOUND when not found', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce(null);

      const result = await verifySignupRegistration({
        email: 'test@example.com', name: 'Test',
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1', acceptedTos: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CHALLENGE_NOT_FOUND');
    });

    it('should return VALIDATION_FAILED on email mismatch', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
        metadata: JSON.stringify({ email: 'other@example.com' }),
      });

      const result = await verifySignupRegistration({
        email: 'test@example.com', name: 'Test',
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1', acceptedTos: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    });

    it('should return EMAIL_EXISTS when user created during verification', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
        metadata: JSON.stringify({ email: 'test@example.com' }),
      });
      mockDb.query.users.findFirst.mockResolvedValueOnce({ id: 'existing-user' });

      const result = await verifySignupRegistration({
        email: 'test@example.com', name: 'Test',
        response: { id: 'cred-1' }, expectedChallenge: 'ch-1', acceptedTos: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EMAIL_EXISTS');
    });

    it('should return userId and passkeyId on success', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
        metadata: JSON.stringify({ email: 'test@example.com' }),
      });
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
          }),
        }),
      });

      mockVerifyRegResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: { id: 'cred-id', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      });

      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const tx = {
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        };
        await fn(tx);
      });

      const result = await verifySignupRegistration({
        email: 'test@example.com', name: 'Test',
        response: { id: 'cred-1', response: { transports: ['internal'] } },
        expectedChallenge: 'ch-1', acceptedTos: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.userId).toBe('test-cuid');
        expect(result.data.passkeyId).toBe('test-cuid');
      }
    });

    it('should return EMAIL_EXISTS on unique constraint violation', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
        metadata: JSON.stringify({ email: 'test@example.com' }),
      });
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
          }),
        }),
      });

      mockVerifyRegResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: { id: 'cred-id', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      });

      mockDb.transaction.mockRejectedValue(new Error('unique constraint violation'));

      const result = await verifySignupRegistration({
        email: 'test@example.com', name: 'Test',
        response: { id: 'cred-1', response: {} },
        expectedChallenge: 'ch-1', acceptedTos: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EMAIL_EXISTS');
    });

    it('should rethrow non-constraint errors', async () => {
      mockDb.query.verificationTokens.findFirst.mockResolvedValueOnce({
        id: 'ch-1', usedAt: null, expiresAt: new Date(Date.now() + 60000),
        metadata: JSON.stringify({ email: 'test@example.com' }),
      });
      mockDb.query.users.findFirst.mockResolvedValueOnce(null);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'ch-1' }]),
          }),
        }),
      });

      mockVerifyRegResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: { id: 'cred-id', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      });

      mockDb.transaction.mockRejectedValue(new Error('connection refused'));

      await expect(verifySignupRegistration({
        email: 'test@example.com', name: 'Test',
        response: { id: 'cred-1', response: {} },
        expectedChallenge: 'ch-1', acceptedTos: true,
      })).rejects.toThrow('connection refused');
    });
  });
});
