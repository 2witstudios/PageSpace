/**
 * Step-up Service (Phase 8 task d2wicbqyia6u30axz8j2j4ab)
 *
 * The thin IO shell around the pure decisions in `step-up-decisions.ts`: it
 * fetches rows, hands them to a decide* function, and persists the outcome.
 * No branch of "is this valid" logic is duplicated here — every verdict is
 * decided by the pure core so it stays unit-testable without mocking.
 *
 * Two equivalent paths mint the same thing — a single-use `stepup_grant`
 * token bound to one pending request's `actionBinding` (see
 * `computeActionBindingHash`) — so a mint endpoint (mcp-tokens, oauth
 * consent) only ever has to call `consumeStepUpGrant`, never care which
 * ceremony produced the grant:
 *   - WebAuthn: `beginWebauthnStepUp` -> `verifyWebauthnStepUp`
 *   - Magic link (passkey-less fallback): `requestMagicLinkStepUp`, then the
 *     verify route calls the existing `verifyMagicLinkToken` and hands its
 *     result to `completeMagicLinkStepUp`.
 *
 * Every public function collapses all non-valid pure-core verdicts into one
 * constant-shape error per ceremony stage (`STEP_UP_INVALID` for the
 * ceremony itself, `STEP_UP_REQUIRED` for grant consumption) — there is no
 * oracle telling a caller whether a token was missing, expired, already
 * used, or bound to something else.
 *
 * @module @pagespace/lib/auth/step-up-service
 */
import * as React from 'react';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and, isNull, sql } from '@pagespace/db/operators';
import { passkeys, users, verificationTokens } from '@pagespace/db/schema/auth';
import { createId } from '@paralleldrive/cuid2';
import {
  generateAuthenticationOptions as simpleGenerateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { hashToken, generateToken } from './token-utils';
import { decryptField } from '../encryption/field-crypto';
import { PASSKEY_CONFIG, type AuthenticationOptionsWithHints } from './passkey-service';
import {
  STEP_UP_CHALLENGE_EXPIRY_MINUTES,
  STEP_UP_GRANT_EXPIRY_MINUTES,
  STEP_UP_MAGIC_LINK_EXPIRY_MINUTES,
} from './step-up-constants';
import {
  computeActionBindingHash,
  decideStepUpChallenge,
  decideStepUpGrant,
  decideMagicLinkStepUpMetadata,
  isStepUpVerdictValid,
} from './step-up-decisions';
import { sendEmail, resolveAppUrl } from '../services/email-service';
import { StepUpConfirmationEmail } from '../email-templates/StepUpConfirmationEmail';

const actionBindingSchema = z.record(z.string(), z.string().nullish());

export type StepUpError =
  | { readonly code: 'NO_PASSKEY' }
  | { readonly code: 'USER_NOT_FOUND' }
  | { readonly code: 'STEP_UP_INVALID' }
  | { readonly code: 'STEP_UP_REQUIRED' };

export type BeginWebauthnStepUpResult =
  | { readonly ok: true; readonly data: { readonly options: AuthenticationOptionsWithHints; readonly challengeId: string } }
  | { readonly ok: false; readonly error: StepUpError };

export type VerifyStepUpResult =
  | { readonly ok: true; readonly data: { readonly stepUpToken: string } }
  | { readonly ok: false; readonly error: StepUpError };

export type ConsumeStepUpGrantResult = { readonly ok: true } | { readonly ok: false; readonly error: StepUpError };

export type RequestMagicLinkStepUpResult = { readonly ok: true } | { readonly ok: false; readonly error: StepUpError };

const mintStepUpGrant = async ({
  userId,
  actionBindingHash,
}: {
  readonly userId: string;
  readonly actionBindingHash: string;
}): Promise<string> => {
  const { token, hash, tokenPrefix } = generateToken('ps_stepup');
  const expiresAt = new Date(Date.now() + STEP_UP_GRANT_EXPIRY_MINUTES * 60 * 1000);

  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'stepup_grant',
    expiresAt,
    metadata: JSON.stringify({ actionBindingHash }),
  });

  return token;
};

const beginWebauthnStepUpSchema = z.object({
  userId: z.string().min(1),
  actionBinding: actionBindingSchema,
});

/** Starts a WebAuthn step-up ceremony, scoped to the caller's own registered passkeys. */
export async function beginWebauthnStepUp(input: unknown): Promise<BeginWebauthnStepUpResult> {
  const parsed = beginWebauthnStepUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  const { userId, actionBinding } = parsed.data;

  const userPasskeys = await db.query.passkeys.findMany({
    where: eq(passkeys.userId, userId),
    columns: { credentialId: true, transports: true },
  });

  if (userPasskeys.length === 0) {
    return { ok: false, error: { code: 'NO_PASSKEY' } };
  }

  const allowCredentials = userPasskeys.map((pk) => ({
    id: pk.credentialId,
    type: 'public-key' as const,
    transports: (pk.transports as AuthenticatorTransportFuture[]) || undefined,
  }));

  const rawOptions = await simpleGenerateAuthenticationOptions({
    rpID: PASSKEY_CONFIG.rpId,
    userVerification: 'required',
    timeout: PASSKEY_CONFIG.timeout,
    allowCredentials,
  });
  const options = { ...rawOptions, hints: ['client-device' as const] };

  const actionBindingHash = computeActionBindingHash(actionBinding);
  const challengeId = createId();
  const challengeHash = hashToken(options.challenge);
  const expiresAt = new Date(Date.now() + STEP_UP_CHALLENGE_EXPIRY_MINUTES * 60 * 1000);

  await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.userId, userId),
        eq(verificationTokens.type, 'webauthn_stepup'),
        isNull(verificationTokens.usedAt),
      ),
    );

  await db.insert(verificationTokens).values({
    id: challengeId,
    userId,
    tokenHash: challengeHash,
    tokenPrefix: options.challenge.substring(0, 12),
    type: 'webauthn_stepup',
    expiresAt,
    metadata: JSON.stringify({ actionBindingHash }),
  });

  return { ok: true, data: { options, challengeId } };
}

const verifyWebauthnStepUpSchema = z.object({
  userId: z.string().min(1),
  response: z.record(z.string(), z.unknown()),
  expectedChallenge: z.string().min(1),
  actionBinding: actionBindingSchema,
});

/** Verifies a WebAuthn step-up assertion and, on success, mints a single-use grant token. */
export async function verifyWebauthnStepUp(input: unknown): Promise<VerifyStepUpResult> {
  const parsed = verifyWebauthnStepUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  const { userId, response, expectedChallenge, actionBinding } = parsed.data;
  const actionBindingHash = computeActionBindingHash(actionBinding);

  const challengeHash = hashToken(expectedChallenge);
  const challengeRow = await db.query.verificationTokens.findFirst({
    where: and(
      eq(verificationTokens.userId, userId),
      eq(verificationTokens.tokenHash, challengeHash),
      eq(verificationTokens.type, 'webauthn_stepup'),
    ),
  });

  const verdict = decideStepUpChallenge({ challenge: challengeRow ?? null, actionBindingHash, now: new Date() });
  if (!challengeRow || !isStepUpVerdictValid(verdict)) {
    return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  }

  const consumedChallenge = await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(verificationTokens.id, challengeRow.id), isNull(verificationTokens.usedAt)))
    .returning();

  if (consumedChallenge.length === 0) {
    return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  }

  const authResponse = response as unknown as AuthenticationResponseJSON;
  const passkey = await db.query.passkeys.findFirst({
    where: eq(passkeys.credentialId, authResponse.id),
  });

  if (!passkey || passkey.userId !== userId) {
    return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: authResponse,
      expectedChallenge,
      expectedOrigin: PASSKEY_CONFIG.origin,
      expectedRPID: PASSKEY_CONFIG.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
      },
    });
  } catch {
    return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  }

  if (!verification.verified) {
    return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const counterUpdate = await db
    .update(passkeys)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(and(eq(passkeys.id, passkey.id), sql`${passkeys.counter} = 0 OR ${passkeys.counter} < ${newCounter}`))
    .returning();

  if (counterUpdate.length === 0) {
    return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  }

  const stepUpToken = await mintStepUpGrant({ userId, actionBindingHash });
  return { ok: true, data: { stepUpToken } };
}

const consumeStepUpGrantSchema = z.object({
  userId: z.string().min(1),
  token: z.string().min(1),
  actionBinding: actionBindingSchema,
});

/** Consumes a single-use step-up grant. Called by the actual mint endpoint (mcp-tokens, oauth/authorize). */
export async function consumeStepUpGrant(input: unknown): Promise<ConsumeStepUpGrantResult> {
  const parsed = consumeStepUpGrantSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'STEP_UP_REQUIRED' } };
  const { userId, token, actionBinding } = parsed.data;
  const actionBindingHash = computeActionBindingHash(actionBinding);

  const tokenHash = hashToken(token);
  const grantRow = await db.query.verificationTokens.findFirst({
    where: and(eq(verificationTokens.tokenHash, tokenHash), eq(verificationTokens.type, 'stepup_grant')),
  });

  const verdict = decideStepUpGrant({ grant: grantRow ?? null, userId, actionBindingHash, now: new Date() });
  if (!grantRow || !isStepUpVerdictValid(verdict)) {
    return { ok: false, error: { code: 'STEP_UP_REQUIRED' } };
  }

  const consumed = await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(verificationTokens.id, grantRow.id), isNull(verificationTokens.usedAt)))
    .returning();

  if (consumed.length === 0) {
    return { ok: false, error: { code: 'STEP_UP_REQUIRED' } };
  }

  return { ok: true };
}

const requestMagicLinkStepUpSchema = z.object({
  userId: z.string().min(1),
  actionBinding: actionBindingSchema,
  next: z.string().min(1).optional(),
});

/** Emails a fresh, single-use, action-bound magic link to the caller's OWN registered address. */
export async function requestMagicLinkStepUp(input: unknown): Promise<RequestMagicLinkStepUpResult> {
  const parsed = requestMagicLinkStepUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'STEP_UP_INVALID' } };
  const { userId, actionBinding, next } = parsed.data;

  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, email: true } });
  if (!user) return { ok: false, error: { code: 'USER_NOT_FOUND' } };

  const actionBindingHash = computeActionBindingHash(actionBinding);
  const { token, hash, tokenPrefix } = generateToken('ps_magic');
  const expiresAt = new Date(Date.now() + STEP_UP_MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000);

  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'magic_link',
    expiresAt,
    metadata: JSON.stringify({ purpose: 'step_up', actionBindingHash, next: next ?? null }),
  });

  const confirmUrl = `${resolveAppUrl()}/api/auth/step-up/magic-link/verify?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: await decryptField(user.email),
    subject: 'Confirm this action in PageSpace',
    react: React.createElement(StepUpConfirmationEmail, { confirmUrl }),
  });

  return { ok: true };
}

const completeMagicLinkStepUpSchema = z.object({
  userId: z.string().min(1),
  metadata: z.string().nullable(),
});

/**
 * Turns a successful `verifyMagicLinkToken` result into a step-up grant, once its metadata is
 * confirmed to be a step-up link (not an ordinary sign-in magic link). The action binding this
 * mints against comes from the token's own metadata — trusted, since it was only reachable via
 * `verifyMagicLinkToken`'s hash-keyed, single-use lookup.
 */
export async function completeMagicLinkStepUp(input: unknown): Promise<VerifyStepUpResult> {
  const parsed = completeMagicLinkStepUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'STEP_UP_INVALID' } };

  const verdict = decideMagicLinkStepUpMetadata(parsed.data.metadata);
  if (verdict.outcome !== 'valid') return { ok: false, error: { code: 'STEP_UP_INVALID' } };

  const stepUpToken = await mintStepUpGrant({ userId: parsed.data.userId, actionBindingHash: verdict.actionBindingHash });
  return { ok: true, data: { stepUpToken } };
}
