/**
 * Pure decision core for the step-up ceremony (Phase 8 task
 * d2wicbqyia6u30axz8j2j4ab). Every function here takes already-fetched data
 * and returns a verdict — no DB, network, or clock reads happen inside this
 * file. The thin IO wrapper (`step-up-service.ts`) fetches rows and calls
 * these to decide, then persists the outcome.
 *
 * `StepUpVerdict` deliberately keeps granular reasons (not_found vs expired
 * vs binding_mismatch) so this pure core is precisely testable, but callers
 * that surface a result to an untrusted caller MUST collapse every non-valid
 * outcome to one constant-shape error — a distinguishable reason is exactly
 * the oracle a replay attacker wants (does the token exist? is it just
 * expired? is it scoped to something else?).
 */
import { hashToken } from './token-utils';
import { secureCompare } from './secure-compare';

/**
 * The binding input is JSON-encoded (sorted `[key, value]` pairs), never an
 * ad-hoc delimiter join: several of these values are attacker/client-supplied
 * free-form strings (OAuth `redirect_uri`/`state`, MCP token names), and an
 * unescaped join would let a value smuggling `&key=` collapse two different
 * bindings to the same hash — defeating the action-bound-grant guarantee.
 */
export const computeActionBindingHash = (
  parts: Readonly<Record<string, string | undefined | null>>,
): string =>
  hashToken(
    JSON.stringify(
      Object.keys(parts)
        .sort()
        .map((key) => [key, parts[key] ?? '']),
    ),
  );

const safeParseJsonObject = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readActionBindingHash = (metadata: string | null): string | null => {
  const parsed = safeParseJsonObject(metadata);
  return typeof parsed?.actionBindingHash === 'string' ? parsed.actionBindingHash : null;
};

const doesBindingMatch = ({
  metadata,
  actionBindingHash,
}: {
  readonly metadata: string | null;
  readonly actionBindingHash: string;
}): boolean => {
  const storedHash = readActionBindingHash(metadata);
  return storedHash !== null && secureCompare(storedHash, actionBindingHash);
};

export type StepUpVerdict =
  | { readonly outcome: 'valid' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'already_used' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'binding_mismatch' };

export const isStepUpVerdictValid = (verdict: StepUpVerdict): boolean => verdict.outcome === 'valid';

export interface StepUpChallengeRecord {
  readonly usedAt: Date | null;
  readonly expiresAt: Date;
  readonly metadata: string | null;
}

/** Decides a `webauthn_stepup` challenge row just before its crypto assertion is checked. */
export const decideStepUpChallenge = ({
  challenge,
  actionBindingHash,
  now,
}: {
  readonly challenge: StepUpChallengeRecord | null;
  readonly actionBindingHash: string;
  readonly now: Date;
}): StepUpVerdict => {
  if (!challenge) return { outcome: 'not_found' };
  if (challenge.usedAt) return { outcome: 'already_used' };
  if (challenge.expiresAt < now) return { outcome: 'expired' };
  return doesBindingMatch({ metadata: challenge.metadata, actionBindingHash })
    ? { outcome: 'valid' }
    : { outcome: 'binding_mismatch' };
};

export interface StepUpGrantRecord {
  readonly userId: string;
  readonly usedAt: Date | null;
  readonly expiresAt: Date;
  readonly metadata: string | null;
}

/** Decides a `stepup_grant` row presented by the mint endpoint (mcp-tokens, oauth/authorize). */
export const decideStepUpGrant = ({
  grant,
  userId,
  actionBindingHash,
  now,
}: {
  readonly grant: StepUpGrantRecord | null;
  readonly userId: string;
  readonly actionBindingHash: string;
  readonly now: Date;
}): StepUpVerdict => {
  if (!grant || grant.userId !== userId) return { outcome: 'not_found' };
  if (grant.usedAt) return { outcome: 'already_used' };
  if (grant.expiresAt < now) return { outcome: 'expired' };
  return doesBindingMatch({ metadata: grant.metadata, actionBindingHash })
    ? { outcome: 'valid' }
    : { outcome: 'binding_mismatch' };
};

export type MagicLinkStepUpVerdict =
  | { readonly outcome: 'valid'; readonly actionBindingHash: string }
  | { readonly outcome: 'not_found' };

/**
 * Decides whether a `verifyMagicLinkToken` success actually represents a
 * step-up grant, as opposed to an ordinary sign-in magic link (same
 * `verificationTokens.type`, disambiguated only by `metadata.purpose`).
 *
 * There is no independent value to bind-check against here — the metadata
 * came from our own DB row, reached only via `verifyMagicLinkToken`'s
 * hash-keyed, single-use lookup, so it is already trusted. The binding check
 * that matters happens later, when the minted grant is spent
 * (`decideStepUpGrant`), against the actual mint request's own parameters.
 */
export const decideMagicLinkStepUpMetadata = (metadata: string | null): MagicLinkStepUpVerdict => {
  const parsed = safeParseJsonObject(metadata);
  return parsed && parsed.purpose === 'step_up' && typeof parsed.actionBindingHash === 'string'
    ? { outcome: 'valid', actionBindingHash: parsed.actionBindingHash }
    : { outcome: 'not_found' };
};

export const parseMagicLinkStepUpNext = (metadata: string | null): string | null => {
  const parsed = safeParseJsonObject(metadata);
  return typeof parsed?.next === 'string' ? parsed.next : null;
};
