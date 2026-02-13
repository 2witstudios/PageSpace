/**
 * Passkey Service
 *
 * WebAuthn/Passkey authentication for passwordless login.
 * Supports platform authenticators (TouchID, FaceID, Windows Hello) and security keys.
 *
 * @module @pagespace/lib/auth/passkey-service
 */

import { z } from 'zod';
import { db, users, passkeys, verificationTokens, eq, and, isNull, sql } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import {
  generateRegistrationOptions as simpleGenerateRegistrationOptions,
  generateAuthenticationOptions as simpleGenerateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { hashToken, generateToken } from './token-utils';

// Configuration
export const PASSKEY_CONFIG = {
  rpName: process.env.WEBAUTHN_RP_NAME || 'PageSpace',
  rpId: process.env.WEBAUTHN_RP_ID || 'localhost',
  origin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
  challengeExpiryMinutes: 5,
  maxPasskeysPerUser: 10,
  timeout: 60000,
  maxNameLength: 255,
  // System user ID for anonymous auth challenges (conditional UI without email)
  // This user must exist in the database - created via migration
  systemUserId: 'system-passkey-auth',
} as const;

// Input validation schemas
const generateRegOptionsSchema = z.object({
  userId: z.string().min(1),
});

const verifyRegSchema = z.object({
  userId: z.string().min(1),
  response: z.any(), // RegistrationResponseJSON validated by simplewebauthn
  expectedChallenge: z.string().min(1),
  name: z.string().max(PASSKEY_CONFIG.maxNameLength).optional(),
});

const generateAuthOptionsSchema = z.object({
  email: z.string().email().optional(),
});

const verifyAuthSchema = z.object({
  response: z.any(), // AuthenticationResponseJSON validated by simplewebauthn
  expectedChallenge: z.string().min(1),
});

const listPasskeysSchema = z.object({
  userId: z.string().min(1),
});

const deletePasskeySchema = z.object({
  userId: z.string().min(1),
  passkeyId: z.string().min(1),
});

const updateNameSchema = z.object({
  userId: z.string().min(1),
  passkeyId: z.string().min(1),
  name: z.string().min(1).max(PASSKEY_CONFIG.maxNameLength),
});

// Result types following zero-trust pattern
export type PasskeyError =
  | { code: 'VALIDATION_FAILED'; message: string }
  | { code: 'USER_NOT_FOUND' }
  | { code: 'USER_SUSPENDED'; userId: string }
  | { code: 'MAX_PASSKEYS_REACHED' }
  | { code: 'CHALLENGE_NOT_FOUND' }
  | { code: 'CHALLENGE_EXPIRED' }
  | { code: 'CHALLENGE_ALREADY_USED' }
  | { code: 'VERIFICATION_FAILED'; message: string }
  | { code: 'CREDENTIAL_NOT_FOUND' }
  | { code: 'COUNTER_REPLAY_DETECTED' }
  | { code: 'PASSKEY_NOT_FOUND' };

export type GenerateRegOptionsResult =
  | { ok: true; data: { options: Awaited<ReturnType<typeof simpleGenerateRegistrationOptions>> } }
  | { ok: false; error: PasskeyError };

export type VerifyRegistrationResult =
  | { ok: true; data: { passkeyId: string } }
  | { ok: false; error: PasskeyError };

export type GenerateAuthOptionsResult =
  | { ok: true; data: { options: Awaited<ReturnType<typeof simpleGenerateAuthenticationOptions>>; challengeId: string } }
  | { ok: false; error: PasskeyError };

export type VerifyAuthResult =
  | { ok: true; data: { userId: string; isNewSession: boolean } }
  | { ok: false; error: PasskeyError };

export type ListPasskeysResult =
  | { ok: true; data: { passkeys: PasskeyInfo[] } }
  | { ok: false; error: PasskeyError };

export type DeletePasskeyResult =
  | { ok: true; data: { deleted: boolean } }
  | { ok: false; error: PasskeyError };

export type UpdateNameResult =
  | { ok: true; data: { updated: boolean } }
  | { ok: false; error: PasskeyError };

export interface PasskeyInfo {
  id: string;
  name: string | null;
  deviceType: string | null;
  backedUp: boolean | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Generate WebAuthn registration options for adding a passkey to an existing account.
 */
export async function generateRegistrationOptions(
  input: unknown
): Promise<GenerateRegOptionsResult> {
  const parsed = generateRegOptionsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { userId } = parsed.data;

  // Check user exists and is not suspended
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true, name: true, suspendedAt: true },
  });

  if (!user) {
    return { ok: false, error: { code: 'USER_NOT_FOUND' } };
  }

  if (user.suspendedAt) {
    return { ok: false, error: { code: 'USER_SUSPENDED', userId } };
  }

  // Check passkey limit
  const existingPasskeys = await db.query.passkeys.findMany({
    where: eq(passkeys.userId, userId),
    columns: { credentialId: true, transports: true },
  });

  if (existingPasskeys.length >= PASSKEY_CONFIG.maxPasskeysPerUser) {
    return { ok: false, error: { code: 'MAX_PASSKEYS_REACHED' } };
  }

  // Convert existing credentials to exclude list
  const excludeCredentials = existingPasskeys.map((pk) => ({
    id: pk.credentialId,
    type: 'public-key' as const,
    transports: (pk.transports as AuthenticatorTransportFuture[]) || undefined,
  }));

  // Generate options
  const options = await simpleGenerateRegistrationOptions({
    rpName: PASSKEY_CONFIG.rpName,
    rpID: PASSKEY_CONFIG.rpId,
    userName: user.email,
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    timeout: PASSKEY_CONFIG.timeout,
  });

  // Clean up old unused challenges
  await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.userId, userId),
        eq(verificationTokens.type, 'webauthn_register'),
        isNull(verificationTokens.usedAt)
      )
    );

  // Store challenge hash
  const challengeHash = hashToken(options.challenge);
  const expiresAt = new Date(Date.now() + PASSKEY_CONFIG.challengeExpiryMinutes * 60 * 1000);

  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: challengeHash,
    tokenPrefix: options.challenge.substring(0, 12),
    type: 'webauthn_register',
    expiresAt,
  });

  return { ok: true, data: { options } };
}

/**
 * Verify registration response and store the new passkey.
 */
export async function verifyRegistration(input: unknown): Promise<VerifyRegistrationResult> {
  const parsed = verifyRegSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { userId, response, expectedChallenge, name } = parsed.data;

  // Look up challenge
  const challengeHash = hashToken(expectedChallenge);
  const challenge = await db.query.verificationTokens.findFirst({
    where: and(
      eq(verificationTokens.userId, userId),
      eq(verificationTokens.tokenHash, challengeHash),
      eq(verificationTokens.type, 'webauthn_register')
    ),
  });

  if (!challenge) {
    return { ok: false, error: { code: 'CHALLENGE_NOT_FOUND' } };
  }

  if (challenge.usedAt) {
    return { ok: false, error: { code: 'CHALLENGE_ALREADY_USED' } };
  }

  if (challenge.expiresAt < new Date()) {
    return { ok: false, error: { code: 'CHALLENGE_EXPIRED' } };
  }

  // Mark challenge as used atomically
  const updateResult = await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(verificationTokens.id, challenge.id),
        isNull(verificationTokens.usedAt)
      )
    )
    .returning();

  if (updateResult.length === 0) {
    return { ok: false, error: { code: 'CHALLENGE_ALREADY_USED' } };
  }

  // Verify registration with SimpleWebAuthn
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: PASSKEY_CONFIG.origin,
      expectedRPID: PASSKEY_CONFIG.rpId,
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: 'VERIFICATION_FAILED', message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: { code: 'VERIFICATION_FAILED', message: 'Verification failed' } };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  // Store passkey
  const passkeyId = createId();
  const publicKeyBase64 = Buffer.from(credential.publicKey).toString('base64url');

  await db.insert(passkeys).values({
    id: passkeyId,
    userId,
    credentialId: credential.id,
    publicKey: publicKeyBase64,
    counter: credential.counter,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: (response as RegistrationResponseJSON).response.transports || null,
    name: name || null,
  });

  return { ok: true, data: { passkeyId } };
}

/**
 * Generate WebAuthn authentication options for login.
 * Email is optional - if provided, filters credentials to that user.
 */
export async function generateAuthenticationOptions(
  input: unknown
): Promise<GenerateAuthOptionsResult> {
  const parsed = generateAuthOptionsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { email } = parsed.data;

  let allowCredentials: { id: string; type: 'public-key'; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  let challengeUserId: string | undefined;

  if (email) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
      columns: { id: true },
    });

    if (user) {
      challengeUserId = user.id;
      const userPasskeys = await db.query.passkeys.findMany({
        where: eq(passkeys.userId, user.id),
        columns: { credentialId: true, transports: true },
      });

      allowCredentials = userPasskeys.map((pk) => ({
        id: pk.credentialId,
        type: 'public-key' as const,
        transports: (pk.transports as AuthenticatorTransportFuture[]) || undefined,
      }));
    }
  }

  const options = await simpleGenerateAuthenticationOptions({
    rpID: PASSKEY_CONFIG.rpId,
    userVerification: 'preferred',
    timeout: PASSKEY_CONFIG.timeout,
    allowCredentials,
  });

  // Store challenge - use a system user ID if no specific user
  const challengeId = createId();
  const challengeHash = hashToken(options.challenge);
  const expiresAt = new Date(Date.now() + PASSKEY_CONFIG.challengeExpiryMinutes * 60 * 1000);

  // For authentication challenges without a specific user, we need a special approach
  // Store with a placeholder user ID or use a different table
  // For now, we'll use a system-level challenge storage pattern
  if (challengeUserId) {
    await db.insert(verificationTokens).values({
      id: challengeId,
      userId: challengeUserId,
      tokenHash: challengeHash,
      tokenPrefix: options.challenge.substring(0, 12),
      type: 'webauthn_auth',
      expiresAt,
    });
  } else {
    // For conditional UI (no specific user), we need to track the challenge differently
    // We use a system user entry - the actual user will be determined by the credential ID during verification
    // IMPORTANT: The system user (PASSKEY_CONFIG.systemUserId) must exist in the database
    await db.insert(verificationTokens).values({
      id: challengeId,
      userId: PASSKEY_CONFIG.systemUserId,
      tokenHash: challengeHash,
      tokenPrefix: options.challenge.substring(0, 12),
      type: 'webauthn_auth',
      expiresAt,
    });
  }

  return { ok: true, data: { options, challengeId } };
}

/**
 * Verify authentication response and return user info.
 */
export async function verifyAuthentication(input: unknown): Promise<VerifyAuthResult> {
  const parsed = verifyAuthSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { response, expectedChallenge } = parsed.data;
  const authResponse = response as AuthenticationResponseJSON;

  // Look up the passkey by credential ID
  const passkey = await db.query.passkeys.findFirst({
    where: eq(passkeys.credentialId, authResponse.id),
    with: {
      user: {
        columns: { id: true, suspendedAt: true },
      },
    },
  });

  if (!passkey) {
    return { ok: false, error: { code: 'CREDENTIAL_NOT_FOUND' } };
  }

  if (passkey.user?.suspendedAt) {
    return { ok: false, error: { code: 'USER_SUSPENDED', userId: passkey.userId } };
  }

  // Look up challenge
  const challengeHash = hashToken(expectedChallenge);
  const challenge = await db.query.verificationTokens.findFirst({
    where: and(
      eq(verificationTokens.tokenHash, challengeHash),
      eq(verificationTokens.type, 'webauthn_auth')
    ),
  });

  if (!challenge) {
    return { ok: false, error: { code: 'CHALLENGE_NOT_FOUND' } };
  }

  if (challenge.usedAt) {
    return { ok: false, error: { code: 'CHALLENGE_ALREADY_USED' } };
  }

  if (challenge.expiresAt < new Date()) {
    return { ok: false, error: { code: 'CHALLENGE_EXPIRED' } };
  }

  // Mark challenge as used atomically
  const updateResult = await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(verificationTokens.id, challenge.id),
        isNull(verificationTokens.usedAt)
      )
    )
    .returning();

  if (updateResult.length === 0) {
    return { ok: false, error: { code: 'CHALLENGE_ALREADY_USED' } };
  }

  // Verify authentication
  const publicKeyBuffer = Buffer.from(passkey.publicKey, 'base64url');

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: authResponse,
      expectedChallenge,
      expectedOrigin: PASSKEY_CONFIG.origin,
      expectedRPID: PASSKEY_CONFIG.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: publicKeyBuffer,
        counter: passkey.counter,
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: 'VERIFICATION_FAILED', message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }

  if (!verification.verified) {
    return { ok: false, error: { code: 'VERIFICATION_FAILED', message: 'Verification failed' } };
  }

  // Atomic counter update with replay protection
  // Counter must be greater than stored value to prevent replay attacks
  const newCounter = verification.authenticationInfo.newCounter;
  const counterUpdateResult = await db
    .update(passkeys)
    .set({
      counter: newCounter,
      lastUsedAt: new Date(),
    })
    .where(
      and(
        eq(passkeys.id, passkey.id),
        // Atomic replay protection: only update if new counter is greater than stored counter
        sql`${passkeys.counter} < ${newCounter}`
      )
    )
    .returning();

  // If no rows were updated, either passkey was deleted or counter replay attack
  if (counterUpdateResult.length === 0) {
    return { ok: false, error: { code: 'COUNTER_REPLAY_DETECTED' } };
  }

  return {
    ok: true,
    data: { userId: passkey.userId, isNewSession: true },
  };
}

/**
 * List passkeys for a user (for settings page).
 */
export async function listUserPasskeys(input: unknown): Promise<ListPasskeysResult> {
  const parsed = listPasskeysSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { userId } = parsed.data;

  const userPasskeys = await db.query.passkeys.findMany({
    where: eq(passkeys.userId, userId),
    columns: {
      id: true,
      name: true,
      deviceType: true,
      backedUp: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: (passkeys, { desc }) => [desc(passkeys.createdAt)],
  });

  return {
    ok: true,
    data: {
      passkeys: userPasskeys.map((pk) => ({
        id: pk.id,
        name: pk.name,
        deviceType: pk.deviceType,
        backedUp: pk.backedUp,
        lastUsedAt: pk.lastUsedAt,
        createdAt: pk.createdAt,
      })),
    },
  };
}

/**
 * Delete a passkey.
 */
export async function deletePasskey(input: unknown): Promise<DeletePasskeyResult> {
  const parsed = deletePasskeySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { userId, passkeyId } = parsed.data;

  const result = await db
    .delete(passkeys)
    .where(
      and(
        eq(passkeys.id, passkeyId),
        eq(passkeys.userId, userId) // Ensure user owns this passkey
      )
    )
    .returning();

  if (result.length === 0) {
    return { ok: false, error: { code: 'PASSKEY_NOT_FOUND' } };
  }

  return { ok: true, data: { deleted: true } };
}

/**
 * Update passkey name.
 */
export async function updatePasskeyName(input: unknown): Promise<UpdateNameResult> {
  const parsed = updateNameSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    };
  }

  const { userId, passkeyId, name } = parsed.data;

  const result = await db
    .update(passkeys)
    .set({ name })
    .where(
      and(
        eq(passkeys.id, passkeyId),
        eq(passkeys.userId, userId) // Ensure user owns this passkey
      )
    )
    .returning();

  if (result.length === 0) {
    return { ok: false, error: { code: 'PASSKEY_NOT_FOUND' } };
  }

  return { ok: true, data: { updated: true } };
}
