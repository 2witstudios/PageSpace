/**
 * Thin server edge for the AI-processing consent record (GDPR Art 13(1)(e)(f), 44).
 *
 * All shaping/validity logic is the pure ./ai-consent module; this file only performs
 * the minimal Drizzle I/O. NOT client-safe — do not add to the ./consent barrel.
 */
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { aiProcessingConsents } from '@pagespace/db/schema';
import {
  AI_CONSENT_POLICY_VERSION,
  buildAiConsentRecord,
  hasValidAiConsent,
  type AiConsentRecord,
} from './ai-consent';

type AiConsentRow = {
  userId: string;
  policyVersion: number;
  consentedAt: Date;
  revokedAt: Date | null;
};

function toRecord(row: AiConsentRow): AiConsentRecord {
  return {
    userId: row.userId,
    policyVersion: row.policyVersion,
    consentedAt: row.consentedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/** The user's current active (non-revoked) AI-processing consent record, if any. */
export async function getActiveAiConsent(userId: string): Promise<AiConsentRecord | null> {
  const row = await db.query.aiProcessingConsents.findFirst({
    where: and(eq(aiProcessingConsents.userId, userId), isNull(aiProcessingConsents.revokedAt)),
  });
  return row ? toRecord(row as AiConsentRow) : null;
}

/** True when the user has a valid consent for the current policy version. */
export async function hasActiveAiConsent(userId: string): Promise<boolean> {
  return hasValidAiConsent(await getActiveAiConsent(userId), AI_CONSENT_POLICY_VERSION);
}

/**
 * Record fresh consent at the current policy version. Any prior active row is revoked
 * first so the unique active-per-user index always holds (handles re-consent on a
 * policy-version bump).
 */
export async function recordAiConsent(userId: string): Promise<AiConsentRecord> {
  const record = buildAiConsentRecord(userId, AI_CONSENT_POLICY_VERSION, new Date().toISOString());
  await db.transaction(async (tx) => {
    await tx
      .update(aiProcessingConsents)
      .set({ revokedAt: new Date() })
      .where(and(eq(aiProcessingConsents.userId, userId), isNull(aiProcessingConsents.revokedAt)));
    await tx.insert(aiProcessingConsents).values({
      userId,
      policyVersion: AI_CONSENT_POLICY_VERSION,
    });
  });
  return record;
}

/** Revoke the user's active AI-processing consent (no-op if none active). */
export async function revokeAiConsent(userId: string): Promise<void> {
  await db
    .update(aiProcessingConsents)
    .set({ revokedAt: new Date() })
    .where(and(eq(aiProcessingConsents.userId, userId), isNull(aiProcessingConsents.revokedAt)));
}
