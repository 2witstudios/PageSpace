import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, users, passkeys, verificationTokens, eq, and, isNull } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Riteway-style assert helper
interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

// Mock @simplewebauthn/server for unit tests
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn().mockImplementation(async (options) => ({
    challenge: 'mock-challenge-base64',
    rp: { name: 'PageSpace', id: 'localhost' },
    user: { id: 'mock-user-id', name: options?.userName || 'test@example.com', displayName: options?.userDisplayName || 'Test User' },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    timeout: 60000,
    attestation: 'none',
    authenticatorSelection: {
      residentKey: options?.authenticatorSelection?.residentKey || 'required',
      requireResidentKey: options?.authenticatorSelection?.requireResidentKey || true,
      userVerification: options?.authenticatorSelection?.userVerification || 'required',
    },
    // Return excludeCredentials if provided (this is what the real library does)
    excludeCredentials: options?.excludeCredentials || [],
  })),
  generateAuthenticationOptions: vi.fn().mockImplementation(async (options) => ({
    challenge: 'mock-auth-challenge-base64',
    timeout: 60000,
    rpId: 'localhost',
    allowCredentials: options?.allowCredentials || [],
    userVerification: options?.userVerification || 'required',
  })),
  verifyRegistrationResponse: vi.fn().mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'mock-credential-id',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
      },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  }),
  verifyAuthenticationResponse: vi.fn().mockResolvedValue({
    verified: true,
    authenticationInfo: {
      newCounter: 1,
      credentialID: 'mock-credential-id',
    },
  }),
}));

import {
  generateRegistrationOptions,
  verifyRegistration,
  generateAuthenticationOptions,
  verifyAuthentication,
  listUserPasskeys,
  deletePasskey,
  updatePasskeyName,
  generateRegistrationOptionsForSignup,
  verifySignupRegistration,
  PASSKEY_CONFIG,
} from './passkey-service';

// System user ID for anonymous auth challenges - must match passkey-service.ts
const SYSTEM_USER_ID = 'system-passkey-auth';

describe('Passkey Service', () => {
  let testUserId: string;
  let testUserEmail: string;

  beforeEach(async () => {
    testUserEmail = `passkey-test-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({
      id: createId(),
      name: 'Passkey Test User',
      email: testUserEmail,
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
      emailVerified: new Date(),
    }).returning();
    testUserId = user.id;

    // Ensure system user exists for anonymous auth challenges
    // Use upsert pattern to handle concurrent test runs
    await db.insert(users).values({
      id: SYSTEM_USER_ID,
      name: 'System',
      email: 'system@pagespace.local',
      provider: 'email',
      role: 'user',
      tokenVersion: 0,
    }).onConflictDoNothing();
  });

  afterEach(async () => {
    // Clean up passkeys
    await db.delete(passkeys).where(eq(passkeys.userId, testUserId));
    // Clean up verification tokens (challenges) - both for test user and system user
    await db.delete(verificationTokens).where(eq(verificationTokens.userId, testUserId));
    await db.delete(verificationTokens).where(eq(verificationTokens.userId, SYSTEM_USER_ID));
    // Clean up user (don't delete system user as other tests may need it)
    await db.delete(users).where(eq(users.id, testUserId));
    vi.clearAllMocks();
  });

  describe('generateRegistrationOptions', () => {
    it('returns WebAuthn registration options for existing user', async () => {
      const result = await generateRegistrationOptions({ userId: testUserId });

      assert({
        given: 'a valid user ID',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'a valid user ID',
          should: 'return options with challenge',
          actual: typeof result.data.options.challenge,
          expected: 'string',
        });

        assert({
          given: 'a valid user ID',
          should: 'return options with rp name',
          actual: result.data.options.rp.name,
          expected: 'PageSpace',
        });
      }
    });

    it('stores challenge hash in verificationTokens', async () => {
      const result = await generateRegistrationOptions({ userId: testUserId });
      if (!result.ok) throw new Error('Expected success');

      const storedChallenge = await db.query.verificationTokens.findFirst({
        where: and(
          eq(verificationTokens.userId, testUserId),
          eq(verificationTokens.type, 'webauthn_register')
        ),
      });

      assert({
        given: 'generated registration options',
        should: 'store challenge hash in database',
        actual: storedChallenge !== undefined && storedChallenge.tokenHash.length > 0,
        expected: true,
      });

      if (storedChallenge) {
        assert({
          given: 'stored challenge',
          should: 'set 5-minute expiry',
          actual: storedChallenge.expiresAt > new Date(),
          expected: true,
        });
      }
    });

    it('returns error for non-existent user', async () => {
      const result = await generateRegistrationOptions({ userId: 'nonexistent-user' });

      assert({
        given: 'a non-existent user ID',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'a non-existent user ID',
          should: 'return USER_NOT_FOUND error',
          actual: result.error.code,
          expected: 'USER_NOT_FOUND',
        });
      }
    });

    it('excludes existing passkey credentials', async () => {
      // Create an existing passkey
      await db.insert(passkeys).values({
        id: createId(),
        userId: testUserId,
        credentialId: 'existing-credential-id',
        publicKey: 'existing-public-key',
        counter: 0,
      });

      const result = await generateRegistrationOptions({ userId: testUserId });

      assert({
        given: 'a user with existing passkeys',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'a user with existing passkeys',
          should: 'include excludeCredentials in options',
          actual: Array.isArray(result.data.options.excludeCredentials),
          expected: true,
        });
      }
    });

    it('returns error when max passkeys reached', async () => {
      // Create max passkeys
      for (let i = 0; i < PASSKEY_CONFIG.maxPasskeysPerUser; i++) {
        await db.insert(passkeys).values({
          id: createId(),
          userId: testUserId,
          credentialId: `credential-${i}`,
          publicKey: `public-key-${i}`,
          counter: 0,
        });
      }

      const result = await generateRegistrationOptions({ userId: testUserId });

      assert({
        given: 'a user at max passkey limit',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'a user at max passkey limit',
          should: 'return MAX_PASSKEYS_REACHED error',
          actual: result.error.code,
          expected: 'MAX_PASSKEYS_REACHED',
        });
      }
    });
  });

  describe('verifyRegistration', () => {
    it('stores passkey on successful verification', async () => {
      // Generate options first
      const optionsResult = await generateRegistrationOptions({ userId: testUserId });
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          attestationObject: 'mock-attestation',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifyRegistration({
        userId: testUserId,
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
        name: 'My MacBook',
      });

      assert({
        given: 'a valid registration response',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        const storedPasskey = await db.query.passkeys.findFirst({
          where: eq(passkeys.userId, testUserId),
        });

        assert({
          given: 'successful registration',
          should: 'store passkey in database',
          actual: storedPasskey !== undefined,
          expected: true,
        });

        assert({
          given: 'successful registration with name',
          should: 'store provided name',
          actual: storedPasskey?.name,
          expected: 'My MacBook',
        });
      }
    });

    it('marks challenge as used after verification', async () => {
      const optionsResult = await generateRegistrationOptions({ userId: testUserId });
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          attestationObject: 'mock-attestation',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      await verifyRegistration({
        userId: testUserId,
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
      });

      const usedChallenge = await db.query.verificationTokens.findFirst({
        where: and(
          eq(verificationTokens.userId, testUserId),
          eq(verificationTokens.type, 'webauthn_register')
        ),
      });

      assert({
        given: 'a used challenge',
        should: 'have usedAt set',
        actual: usedChallenge?.usedAt != null, // checks both null and undefined
        expected: true,
      });
    });

    it('returns error for expired challenge', async () => {
      const optionsResult = await generateRegistrationOptions({ userId: testUserId });
      if (!optionsResult.ok) throw new Error('Setup failed');

      // Manually expire the challenge
      await db.update(verificationTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(and(
          eq(verificationTokens.userId, testUserId),
          eq(verificationTokens.type, 'webauthn_register')
        ));

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          attestationObject: 'mock-attestation',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifyRegistration({
        userId: testUserId,
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
      });

      assert({
        given: 'an expired challenge',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'an expired challenge',
          should: 'return CHALLENGE_EXPIRED error',
          actual: result.error.code,
          expected: 'CHALLENGE_EXPIRED',
        });
      }
    });
  });

  describe('generateAuthenticationOptions', () => {
    it('returns authentication options without email', async () => {
      const result = await generateAuthenticationOptions({});

      assert({
        given: 'no email provided',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'no email provided',
          should: 'return options with challenge',
          actual: typeof result.data.options.challenge,
          expected: 'string',
        });
      }
    });

    it('filters allowCredentials when email provided', async () => {
      // Create a passkey for the user
      await db.insert(passkeys).values({
        id: createId(),
        userId: testUserId,
        credentialId: 'user-credential-id',
        publicKey: 'user-public-key',
        counter: 0,
        transports: ['internal'],
      });

      const result = await generateAuthenticationOptions({ email: testUserEmail });

      assert({
        given: 'an email with existing passkeys',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'an email with existing passkeys',
          should: 'include allowCredentials in options',
          actual: Array.isArray(result.data.options.allowCredentials),
          expected: true,
        });
      }
    });

    it('stores challenge hash for verification', async () => {
      const result = await generateAuthenticationOptions({});
      if (!result.ok) throw new Error('Expected success');

      const storedChallenge = await db.query.verificationTokens.findFirst({
        where: eq(verificationTokens.type, 'webauthn_auth'),
      });

      assert({
        given: 'generated auth options',
        should: 'store challenge hash in database',
        actual: storedChallenge !== undefined,
        expected: true,
      });
    });
  });

  describe('verifyAuthentication', () => {
    let testPasskeyId: string;

    beforeEach(async () => {
      // Create a passkey for authentication tests
      const [passkey] = await db.insert(passkeys).values({
        id: createId(),
        userId: testUserId,
        credentialId: 'mock-credential-id',
        publicKey: 'mock-public-key-base64',
        counter: 0,
        transports: ['internal'],
      }).returning();
      testPasskeyId = passkey.id;
    });

    it('returns userId on successful authentication', async () => {
      const optionsResult = await generateAuthenticationOptions({ email: testUserEmail });
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          authenticatorData: 'mock-auth-data',
          signature: 'mock-signature',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifyAuthentication({
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
      });

      assert({
        given: 'a valid authentication response',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'a valid authentication response',
          should: 'return correct userId',
          actual: result.data.userId,
          expected: testUserId,
        });
      }
    });

    it('updates counter after successful authentication', async () => {
      const optionsResult = await generateAuthenticationOptions({ email: testUserEmail });
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          authenticatorData: 'mock-auth-data',
          signature: 'mock-signature',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      await verifyAuthentication({
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
      });

      const updatedPasskey = await db.query.passkeys.findFirst({
        where: eq(passkeys.id, testPasskeyId),
      });

      assert({
        given: 'successful authentication',
        should: 'update counter',
        actual: (updatedPasskey?.counter ?? 0) > 0,
        expected: true,
      });

      assert({
        given: 'successful authentication',
        should: 'update lastUsedAt',
        actual: updatedPasskey?.lastUsedAt !== null,
        expected: true,
      });
    });

    it('returns error for credential not found', async () => {
      const optionsResult = await generateAuthenticationOptions({});
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'unknown-credential-id',
        rawId: 'unknown-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          authenticatorData: 'mock-auth-data',
          signature: 'mock-signature',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifyAuthentication({
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
      });

      assert({
        given: 'an unknown credential ID',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'an unknown credential ID',
          should: 'return CREDENTIAL_NOT_FOUND error',
          actual: result.error.code,
          expected: 'CREDENTIAL_NOT_FOUND',
        });
      }
    });
  });

  describe('listUserPasskeys', () => {
    it('returns empty array for user with no passkeys', async () => {
      const result = await listUserPasskeys({ userId: testUserId });

      assert({
        given: 'a user with no passkeys',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'a user with no passkeys',
          should: 'return empty array',
          actual: result.data.passkeys,
          expected: [],
        });
      }
    });

    it('returns passkey list for user with passkeys', async () => {
      await db.insert(passkeys).values({
        id: createId(),
        userId: testUserId,
        credentialId: 'credential-1',
        publicKey: 'public-key-1',
        counter: 5,
        name: 'My Phone',
        deviceType: 'multiDevice',
        backedUp: true,
        lastUsedAt: new Date(),
      });

      const result = await listUserPasskeys({ userId: testUserId });

      assert({
        given: 'a user with passkeys',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'a user with passkeys',
          should: 'return passkey array with one item',
          actual: result.data.passkeys.length,
          expected: 1,
        });

        assert({
          given: 'a user with passkeys',
          should: 'include passkey name',
          actual: result.data.passkeys[0].name,
          expected: 'My Phone',
        });

        assert({
          given: 'a user with passkeys',
          should: 'not expose publicKey',
          actual: 'publicKey' in result.data.passkeys[0],
          expected: false,
        });
      }
    });
  });

  describe('deletePasskey', () => {
    let testPasskeyId: string;

    beforeEach(async () => {
      const [passkey] = await db.insert(passkeys).values({
        id: createId(),
        userId: testUserId,
        credentialId: 'delete-test-credential',
        publicKey: 'delete-test-public-key',
        counter: 0,
      }).returning();
      testPasskeyId = passkey.id;
    });

    it('deletes passkey owned by user', async () => {
      const result = await deletePasskey({ userId: testUserId, passkeyId: testPasskeyId });

      assert({
        given: 'a valid passkey owned by user',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      const deletedPasskey = await db.query.passkeys.findFirst({
        where: eq(passkeys.id, testPasskeyId),
      });

      assert({
        given: 'successful deletion',
        should: 'remove passkey from database',
        actual: deletedPasskey,
        expected: undefined,
      });
    });

    it('returns error for passkey owned by different user', async () => {
      const result = await deletePasskey({ userId: 'other-user-id', passkeyId: testPasskeyId });

      assert({
        given: 'a passkey owned by different user',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'a passkey owned by different user',
          should: 'return PASSKEY_NOT_FOUND error',
          actual: result.error.code,
          expected: 'PASSKEY_NOT_FOUND',
        });
      }
    });
  });

  describe('updatePasskeyName', () => {
    let testPasskeyId: string;

    beforeEach(async () => {
      const [passkey] = await db.insert(passkeys).values({
        id: createId(),
        userId: testUserId,
        credentialId: 'rename-test-credential',
        publicKey: 'rename-test-public-key',
        counter: 0,
        name: 'Original Name',
      }).returning();
      testPasskeyId = passkey.id;
    });

    it('updates passkey name', async () => {
      const result = await updatePasskeyName({
        userId: testUserId,
        passkeyId: testPasskeyId,
        name: 'New Name',
      });

      assert({
        given: 'a valid passkey and new name',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      const updatedPasskey = await db.query.passkeys.findFirst({
        where: eq(passkeys.id, testPasskeyId),
      });

      assert({
        given: 'successful rename',
        should: 'update name in database',
        actual: updatedPasskey?.name,
        expected: 'New Name',
      });
    });

    it('returns error for passkey owned by different user', async () => {
      const result = await updatePasskeyName({
        userId: 'other-user-id',
        passkeyId: testPasskeyId,
        name: 'New Name',
      });

      assert({
        given: 'a passkey owned by different user',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'a passkey owned by different user',
          should: 'return PASSKEY_NOT_FOUND error',
          actual: result.error.code,
          expected: 'PASSKEY_NOT_FOUND',
        });
      }
    });

    it('validates name length', async () => {
      const result = await updatePasskeyName({
        userId: testUserId,
        passkeyId: testPasskeyId,
        name: 'A'.repeat(256), // Too long
      });

      assert({
        given: 'a name exceeding max length',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'a name exceeding max length',
          should: 'return VALIDATION_FAILED error',
          actual: result.error.code,
          expected: 'VALIDATION_FAILED',
        });
      }
    });
  });

  describe('generateRegistrationOptionsForSignup', () => {
    const signupEmail = `passkey-signup-${Date.now()}@example.com`;
    const signupName = 'Test Signup User';

    afterEach(async () => {
      // Clean up any signup challenges
      await db.delete(verificationTokens).where(eq(verificationTokens.type, 'webauthn_signup'));
      // Clean up any users created during signup tests
      await db.delete(users).where(eq(users.email, signupEmail.toLowerCase()));
    });

    it('generates registration options for new email', async () => {
      const result = await generateRegistrationOptionsForSignup({
        email: signupEmail,
        name: signupName,
      });

      assert({
        given: 'a new email for signup',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        assert({
          given: 'a new email for signup',
          should: 'return options with challenge',
          actual: typeof result.data.options.challenge,
          expected: 'string',
        });

        assert({
          given: 'a new email for signup',
          should: 'return a challengeId',
          actual: typeof result.data.challengeId,
          expected: 'string',
        });
      }
    });

    it('stores challenge for verification', async () => {
      const result = await generateRegistrationOptionsForSignup({
        email: signupEmail,
        name: signupName,
      });

      if (!result.ok) throw new Error('Expected success');

      const storedChallenge = await db.query.verificationTokens.findFirst({
        where: eq(verificationTokens.type, 'webauthn_signup'),
      });

      assert({
        given: 'generated signup options',
        should: 'store challenge in database',
        actual: storedChallenge !== undefined,
        expected: true,
      });
    });

    it('returns error for existing email', async () => {
      // Use the existing test user's email
      const result = await generateRegistrationOptionsForSignup({
        email: testUserEmail,
        name: 'Existing User',
      });

      assert({
        given: 'an existing email',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'an existing email',
          should: 'return EMAIL_EXISTS error',
          actual: result.error.code,
          expected: 'EMAIL_EXISTS',
        });
      }
    });

    it('validates email format', async () => {
      const result = await generateRegistrationOptionsForSignup({
        email: 'invalid-email',
        name: signupName,
      });

      assert({
        given: 'an invalid email',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'an invalid email',
          should: 'return VALIDATION_FAILED error',
          actual: result.error.code,
          expected: 'VALIDATION_FAILED',
        });
      }
    });
  });

  describe('verifySignupRegistration', () => {
    const signupEmail = `passkey-verify-signup-${Date.now()}@example.com`;
    const signupName = 'Test Verify Signup User';

    afterEach(async () => {
      // Clean up any signup challenges
      await db.delete(verificationTokens).where(eq(verificationTokens.type, 'webauthn_signup'));
      // Clean up any users and passkeys created during signup tests
      const createdUser = await db.query.users.findFirst({
        where: eq(users.email, signupEmail.toLowerCase()),
      });
      if (createdUser) {
        await db.delete(passkeys).where(eq(passkeys.userId, createdUser.id));
        await db.delete(users).where(eq(users.id, createdUser.id));
      }
    });

    it('creates user and passkey on successful verification', async () => {
      // Generate options first
      const optionsResult = await generateRegistrationOptionsForSignup({
        email: signupEmail,
        name: signupName,
      });
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          attestationObject: 'mock-attestation',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifySignupRegistration({
        email: signupEmail,
        name: signupName,
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
        acceptedTos: true,
      });

      assert({
        given: 'a valid signup registration response',
        should: 'return ok: true',
        actual: result.ok,
        expected: true,
      });

      if (result.ok) {
        // Verify user was created
        const createdUser = await db.query.users.findFirst({
          where: eq(users.email, signupEmail.toLowerCase()),
        });

        assert({
          given: 'successful signup verification',
          should: 'create user in database',
          actual: createdUser !== undefined,
          expected: true,
        });

        assert({
          given: 'successful signup verification',
          should: 'set provider to email',
          actual: createdUser?.provider,
          expected: 'email',
        });

        assert({
          given: 'successful signup verification',
          should: 'mark email as verified',
          actual: createdUser?.emailVerified !== null,
          expected: true,
        });

        // Verify passkey was created
        const createdPasskey = await db.query.passkeys.findFirst({
          where: eq(passkeys.userId, result.data.userId),
        });

        assert({
          given: 'successful signup verification',
          should: 'create passkey in database',
          actual: createdPasskey !== undefined,
          expected: true,
        });
      }
    });

    it('returns error for TOS not accepted', async () => {
      const optionsResult = await generateRegistrationOptionsForSignup({
        email: signupEmail,
        name: signupName,
      });
      if (!optionsResult.ok) throw new Error('Setup failed');

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          attestationObject: 'mock-attestation',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifySignupRegistration({
        email: signupEmail,
        name: signupName,
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
        acceptedTos: false,
      });

      assert({
        given: 'TOS not accepted',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'TOS not accepted',
          should: 'return VALIDATION_FAILED error',
          actual: result.error.code,
          expected: 'VALIDATION_FAILED',
        });
      }
    });

    it('returns error for expired challenge', async () => {
      const optionsResult = await generateRegistrationOptionsForSignup({
        email: signupEmail,
        name: signupName,
      });
      if (!optionsResult.ok) throw new Error('Setup failed');

      // Expire the challenge
      await db.update(verificationTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verificationTokens.type, 'webauthn_signup'));

      const mockResponse = {
        id: 'mock-credential-id',
        rawId: 'mock-credential-id',
        response: {
          clientDataJSON: 'mock-client-data',
          attestationObject: 'mock-attestation',
        },
        type: 'public-key' as const,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      };

      const result = await verifySignupRegistration({
        email: signupEmail,
        name: signupName,
        response: mockResponse,
        expectedChallenge: optionsResult.data.options.challenge,
        acceptedTos: true,
      });

      assert({
        given: 'an expired challenge',
        should: 'return ok: false',
        actual: result.ok,
        expected: false,
      });

      if (!result.ok) {
        assert({
          given: 'an expired challenge',
          should: 'return CHALLENGE_EXPIRED error',
          actual: result.error.code,
          expected: 'CHALLENGE_EXPIRED',
        });
      }
    });
  });
});
