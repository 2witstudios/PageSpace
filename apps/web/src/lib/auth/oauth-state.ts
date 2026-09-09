import crypto from 'crypto';
import { z } from 'zod/v4';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { DESKTOP_SHELLS } from './desktop-shell';

// State expires after 10 minutes — prevents replay attacks
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

// Bound matches the request-body validators in google/signin & apple/signin.
// Real tokens are `ps_invite_<cuid2>` (~33 chars) — 128 leaves headroom while
// keeping the signed+base64 state well under provider redirect-URL limits.
const INVITE_TOKEN_MAX_LENGTH = 128;

const oauthStateDataSchema = z.object({
  returnUrl: z.string().max(2048).optional(),
  // 'android' is accepted so a signed state can name the platform that started
  // the flow. Without it the enum rejected the value outright, which is why no
  // server path could emit the `pagespace://` handoff for Android and the
  // custom-scheme intent filter Phase C shipped stayed inert.
  //
  // Accepting the value is the unblock, NOT permission to emit the handoff: the
  // OAuth callbacks still deep-link for iOS only, and the two preconditions that
  // gate widening them (binding the handoff to the app that started the flow, and
  // having anything consume `appUrlOpen` at all) are set out at that branch in
  // `api/auth/google/callback/route.ts`.
  platform: z.enum(['web', 'desktop', 'ios', 'android']).optional(),
  // Which desktop app started the flow. One Electron codebase ships two, each
  // with its own protocol scheme, and the callback has to deep-link back into
  // the one the user actually signed in from. Absent for web, iOS and older
  // desktop builds, which all mean PageSpace.
  shell: z.enum(DESKTOP_SHELLS).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceName: z.string().max(255).optional(),
  inviteToken: z.string().min(1).max(INVITE_TOKEN_MAX_LENGTH).optional(),
  timestamp: z.number().finite(),
});

export { INVITE_TOKEN_MAX_LENGTH };

export type OAuthStateData = z.infer<typeof oauthStateDataSchema>;

export type VerifyOAuthStateResult =
  | { status: 'valid'; data: OAuthStateData }
  | { status: 'invalid_signature' }
  | { status: 'expired' }
  | { status: 'unsigned'; returnUrl?: string }
  | { status: 'malformed' };

/**
 * Verify an HMAC-signed OAuth state parameter.
 * Returns a discriminated result so callers can handle each case appropriately:
 * - 'valid': signature verified, data is trustworthy
 * - 'invalid_signature': sig field present but doesn't match (reject)
 * - 'unsigned': parseable JSON but no sig field (safe defaults)
 * - 'malformed': unparseable (safe defaults)
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyOAuthState(stateBase64: string): VerifyOAuthStateResult {
  const secret = process.env.OAUTH_STATE_SECRET;

  try {
    const parsed = JSON.parse(Buffer.from(stateBase64, 'base64').toString('utf-8'));

    if (!parsed.data || !parsed.sig) {
      // No signature — treat as unsigned legacy state
      return { status: 'unsigned', returnUrl: parsed.returnUrl };
    }

    if (!secret) {
      return { status: 'invalid_signature' };
    }

    const { data, sig } = parsed;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(data))
      .digest('hex');

    if (!secureCompare(String(sig), expected)) {
      return { status: 'invalid_signature' };
    }

    // Schema validation AFTER HMAC verification — treats the HMAC-verified
    // payload as still-untrusted data until it matches the expected shape.
    // Defense in depth against legacy states, malformed internal mints, or
    // any future key-compromise that would otherwise hand raw JSON straight
    // into branch selection and redirect flows.
    const parsedResult = oauthStateDataSchema.safeParse(data);
    if (!parsedResult.success) {
      return { status: 'malformed' };
    }

    if (Date.now() - parsedResult.data.timestamp > STATE_MAX_AGE_MS) {
      return { status: 'expired' };
    }

    return { status: 'valid', data: parsedResult.data };
  } catch {
    return { status: 'malformed' };
  }
}
