/**
 * Pure response-shaping helpers for the user-enumeration / email-harvest
 * remediations (security audit findings M3, L1, L2).
 *
 * The shared theme across all three findings is that an attacker can probe a
 * user-lookup endpoint and learn things they should not: a public profile's
 * email (M3), whether an arbitrary email maps to an account plus that person's
 * name/avatar (L1), or the exact relationship state between themselves and any
 * email (L2).
 *
 * These functions isolate the "what data leaves the server" decision into pure
 * projections so it can be unit-tested in isolation and cannot drift back to a
 * leaky shape unnoticed. The route handlers do the I/O (auth, rate limiting, DB
 * reads); these helpers decide the response body.
 */

// ============================================================================
// M3 — Email harvest via public-profile substring search
// ============================================================================

/** A public-profile row as selected from `userProfiles` (NO email column). */
export interface PublicProfileRow {
  userId: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

/** The public-profile shape returned to substring searchers. Never has email. */
export interface PublicProfileResult {
  userId: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

export interface ExactEmailMatchResult extends PublicProfileResult {
  email: string;
}

/**
 * Project a public-profile row to the shape returned for unanchored substring
 * matches. Critically, this NEVER carries an email: a 2-char substring search
 * iterated `aa..zz` would otherwise harvest every public profile's email, and
 * email is not part of the public-profile data model.
 */
export function buildPublicProfileResult(row: PublicProfileRow): PublicProfileResult {
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
  };
}

/**
 * The exact-email-match branch may surface the email because the caller already
 * supplied the full address (they cannot learn an address they did not type).
 * This composes the public-profile base with that already-known email.
 */
export function buildExactEmailMatchResult(
  base: PublicProfileResult,
  email: string,
): ExactEmailMatchResult {
  return { ...base, email };
}

// ============================================================================
// L1 — /api/users/find leaks existence + name/avatar for any exact email
// ============================================================================

export interface FindUserCandidate {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export type FindUserOutcome =
  | { found: true; user: FindUserCandidate }
  | { found: false };

/**
 * Collapse the two distinguishable outcomes — "no account with this email" and
 * "an account exists but the caller has no relationship to it" — into a single
 * uniform not-found result, so an attacker cannot enumerate which emails have
 * accounts (nor harvest the owner's name/avatar).
 *
 * Identity is only surfaced when the caller already shares context with the
 * target (a shared drive or accepted connection — decided by the route via the
 * DB) or when the caller is resolving their own account.
 */
export function resolveFindUser(
  candidate: FindUserCandidate | null,
  callerId: string,
  callerCanView: boolean,
): FindUserOutcome {
  if (!candidate) return { found: false };
  if (candidate.id === callerId || callerCanView) {
    return { found: true, user: candidate };
  }
  return { found: false };
}

// ============================================================================
// L2 — /api/connections/search distinguishable relationship state
// ============================================================================

export type ConnectionStatus = 'PENDING' | 'ACCEPTED' | 'BLOCKED';

export interface ConnectionSearchProfile {
  id: string;
  name: string | null;
  email: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

export interface ConnectionSearchInput {
  /** True when the searched email belongs to the caller themselves. */
  isSelf: boolean;
  /** The matched user, or null when no account has that email. */
  target: ConnectionSearchProfile | null;
  /** Existing connection status between caller and target, or null if none. */
  existingStatus: ConnectionStatus | null;
}

export type ConnectionSearchResponse =
  | { user: ConnectionSearchProfile }
  | { user: null };

/**
 * Collapse every non-actionable outcome — self-search, no account, and any
 * existing relationship state (PENDING / ACCEPTED / BLOCKED) — into a single
 * generic `{ user: null }` response with no distinguishing error string. This
 * prevents an attacker from telling "no such user" apart from "blocked you" /
 * "already connected" / "request pending", any of which would otherwise leak
 * both existence and relationship state.
 *
 * A profile is only returned when a connection request can actually be sent:
 * the account exists, it is not the caller, and no connection row exists yet.
 */
export function buildConnectionSearchResult(
  input: ConnectionSearchInput,
): ConnectionSearchResponse {
  if (input.isSelf || !input.target || input.existingStatus !== null) {
    return { user: null };
  }
  return { user: input.target };
}
