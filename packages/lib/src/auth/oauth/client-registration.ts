/**
 * Client registration metadata validation (ADR 0004 Decisions 3 and 7).
 *
 * Registration ships through the developer console and the `oauthApps.*`
 * operations, not RFC 7591's `registration_endpoint` (still deferred, still
 * additive). Either way the input is a request body: `unknown` by
 * construction. This validator takes it as such, never throws, and returns a
 * typed error list rather than a message — the console renders the messages,
 * the contract is the codes.
 *
 * Two properties matter more than the field list:
 *
 *  1. **The redirect rules are not restated here.** `validateRedirectUri`
 *     (`./clients`) is called with `firstParty: false`, which is what makes
 *     "registration accepts exactly what authorize will honour" true by
 *     construction rather than by two rules being kept in sync — and makes it
 *     impossible to register the loopback port wildcard, which belongs to the
 *     CLI alone.
 *  2. **`allowedScopes` holds SHAPES, not scopes.** A cap says "this app may
 *     ask for member access to some drive", never "to drive abc123" — the
 *     user picks the drive at consent. So `drive:member` is a legal cap and
 *     `drive:abc123:member` is not.
 *
 * @module @pagespace/lib/auth/oauth/client-registration
 */

import { z } from 'zod';
import { validateRedirectUri } from './clients';
import { NAME_CONTROL_CHAR_RE } from './scopes';

/**
 * What a non-string entry is reported as. A FIXED placeholder: `String(value)`
 * on a caller-supplied object invokes `toString`/`valueOf`, and a plain JSON
 * body can shadow either with a non-callable — `{"toString":"no"}` makes
 * coercion throw `TypeError: Cannot convert object to primitive value`, which
 * would turn an untrusted registration body into a 500 and break this module's
 * never-throw contract (reported by Codex on PR #2612). `field` already
 * locates the entry, so nothing is lost by not echoing it.
 */
const NON_STRING_PLACEHOLDER = '[non-string]';

/** The three fixed caps plus the four `drive` shape tokens (ADR 0004 Decision 7). */
const ALLOWED_SCOPE_SHAPES = new Set(['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role']);

/**
 * Scope tokens that exist in the grammar but which a third-party client may
 * never declare — separated from unknown tokens so the console can say "you
 * cannot ask for this" rather than "we do not know this". `drive:<id>…`
 * shapes land here too: they are real scopes, just not caps.
 */
const FORBIDDEN_SCOPE_PREFIXES = ['account', 'all_drives', 'manage_keys', 'update_key', 'activate_key', 'name'];

export interface ClientRegistration {
  name: string;
  description?: string;
  logoUrl?: string;
  homepageUrl?: string;
  redirectUris: string[];
  allowedScopes?: string[];
}

export type ClientRegistrationError =
  | { code: 'invalid_input'; field?: string }
  | { code: 'invalid_name'; field: 'name' }
  | { code: 'invalid_description'; field: 'description' }
  | { code: 'invalid_logo_url'; field: 'logoUrl' }
  | { code: 'invalid_homepage_url'; field: 'homepageUrl' }
  | { code: 'invalid_redirect_uris'; field: 'redirectUris' }
  | { code: 'invalid_redirect_uri'; field: string }
  | { code: 'duplicate_redirect_uri'; field: string }
  | { code: 'invalid_allowed_scopes'; field: 'allowedScopes' }
  | { code: 'unknown_scope'; field: string; scope: string }
  | { code: 'forbidden_scope'; field: string; scope: string }
  | { code: 'duplicate_scope'; field: string; scope: string };

export type ClientRegistrationResult =
  | { ok: true; value: ClientRegistration }
  | { ok: false; errors: ClientRegistrationError[] };

/**
 * An https URL with nothing clever in it. Used for `logoUrl`/`homepageUrl`,
 * which the consent screen renders: `http:` would be a mixed-content
 * downgrade, and `javascript:`/`data:` on a rendered link or image is the
 * whole attack.
 */
function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
}

/**
 * Bidi controls, directional isolates, zero-width characters, the Arabic
 * letter mark and the BOM. Not control characters by the `\x00-\x1F\x7F`
 * definition, but they reorder or hide rendered text, which is the same attack
 * against the same surface.
 */
const INVISIBLE_CHAR_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/**
 * Text that will be rendered on the consent screen, held to the rule mcp key
 * names already meet (`scopes.ts`, `NAME_CONTROL_CHAR_RE` + the length and
 * control-char check in `parseScopeList`).
 *
 * The consent screen is part of the security boundary — ADR 0002 Decision 5
 * opens by saying zero trust includes the user being able to trust what the
 * screen says. These strings render beside the "Unverified app" badge, which
 * is precisely where a spoofed one pays off: an RTL override can visually
 * reorder the text around the badge that is the whole trust signal, and
 * zero-width characters can hide part of a name that would otherwise look
 * wrong. Deliberately NOT an ASCII rule — `归档` and `Café App` are ordinary
 * names and stay valid.
 */
const isSafeDisplayText = (value: string): boolean =>
  !NAME_CONTROL_CHAR_RE.test(value) && !INVISIBLE_CHAR_RE.test(value);

/*
 * Per-field schemas below, checked independently so one bad field never masks
 * another — a registration form should show every problem at once, and an API
 * caller should not have to fix errors one round trip at a time. Array
 * ENTRIES stay `unknown` here; which values are declarable is
 * `classifyScopeShape`'s and `validateRedirectUri`'s job, so a malformed entry
 * and a forbidden one keep distinct error codes.
 */

const NAME = z
  .string()
  .min(1)
  .max(100)
  // Whitespace-only renders as an unnamed app; leading or trailing whitespace
  // lets a name push itself away from the badge it sits beside. Requiring the
  // stored name to equal its own trim means what is stored is what renders —
  // rejected rather than silently trimmed, because silently rewriting a
  // developer's input is its own kind of surprise.
  .refine((value) => value.trim().length > 0)
  .refine((value) => value === value.trim())
  .refine(isSafeDisplayText);
// Same surface, same rule: the description renders on the consent screen
// directly beneath the name.
const DESCRIPTION = z.string().max(500).refine(isSafeDisplayText);
const HTTPS_URL = z.string().refine(isHttpsUrl);
const REDIRECT_URIS = z.array(z.unknown()).min(1).max(10);
// There are only six legal shapes, so anything longer is a mistake or an
// attempt to make the error list itself the payload.
const ALLOWED_SCOPES = z.array(z.unknown()).min(1).max(20);

/** Classify one `allowedScopes` entry. `null` means it is a legal cap. */
function classifyScopeShape(scope: string): 'unknown' | 'forbidden' | null {
  if (ALLOWED_SCOPE_SHAPES.has(scope)) return null;
  for (const prefix of FORBIDDEN_SCOPE_PREFIXES) {
    if (scope === prefix || scope.startsWith(`${prefix}:`)) return 'forbidden';
  }
  // A concrete `drive:<id>…` is a real scope but not a cap — the user picks
  // the drive at consent, so a client declaring one has misunderstood the
  // field rather than asked for something unknown.
  if (scope.startsWith('drive:')) return 'forbidden';
  return 'unknown';
}

/**
 * Validate untrusted client-registration metadata. Total: every input path
 * returns a result, none throws.
 */
export function validateClientRegistration(input: unknown): ClientRegistrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ code: 'invalid_input' }] };
  }

  // Read by name rather than spread: a registration body never contributes a
  // field the caller did not ask for (`firstParty`, `verified`, an id), in
  // either direction.
  const candidate = input as Record<string, unknown>;
  const errors: ClientRegistrationError[] = [];

  if (!NAME.safeParse(candidate.name).success) {
    errors.push({ code: 'invalid_name', field: 'name' });
  }

  if (candidate.description !== undefined && !DESCRIPTION.safeParse(candidate.description).success) {
    errors.push({ code: 'invalid_description', field: 'description' });
  }

  if (candidate.logoUrl !== undefined && !HTTPS_URL.safeParse(candidate.logoUrl).success) {
    errors.push({ code: 'invalid_logo_url', field: 'logoUrl' });
  }

  if (candidate.homepageUrl !== undefined && !HTTPS_URL.safeParse(candidate.homepageUrl).success) {
    errors.push({ code: 'invalid_homepage_url', field: 'homepageUrl' });
  }

  // The parse RESULT carries the narrowed array, so there is no second
  // `Array.isArray` check to keep in step with the schema.
  const redirectParse = REDIRECT_URIS.safeParse(candidate.redirectUris);
  // Collected in the accepting branch so the success value is carried forward
  // directly. Only read once `errors` is empty, which cannot happen unless
  // that branch ran — so no re-check, and no branch a test could not reach.
  let acceptedRedirectUris: string[] = [];
  if (!redirectParse.success) {
    errors.push({ code: 'invalid_redirect_uris', field: 'redirectUris' });
  } else {
    const seen = new Set<string>();
    redirectParse.data.forEach((uri: unknown, index: number) => {
      const field = `redirectUris[${index}]`;
      // The authorize-time rules, applied as the least-privileged client
      // there is: nothing registered here can claim the first-party loopback
      // port wildcard.
      if (typeof uri !== 'string' || !validateRedirectUri({ redirectUris: [uri], firstParty: false }, uri)) {
        errors.push({ code: 'invalid_redirect_uri', field });
        return;
      }
      // Dedupe on the NORMALIZED uri, because that is what authorize matches
      // on (`validateRedirectUri` compares `href`, and the URL parser drops the
      // default port and lowercases scheme and host). A raw-string dedupe would
      // store two entries the authorize endpoint treats as one.
      // Safe to parse unguarded: `validateRedirectUri` returned true, and it
      // only does that for a string it parsed itself. A try/catch here would be
      // a branch no input can reach, and the invariant is pinned directly by
      // `every uri validateRedirectUri accepts is parseable` in the test file —
      // so if that contract ever changes, a test says so rather than a 500.
      const normalized = new URL(uri).href;
      if (seen.has(normalized)) {
        errors.push({ code: 'duplicate_redirect_uri', field });
        return;
      }
      seen.add(normalized);
    });
    acceptedRedirectUris = redirectParse.data as string[];
  }

  // `undefined` means "no cap declared" and is legal; anything else must be a
  // well-formed array. An explicit `[]` is a form mistake, and rejecting it is
  // the fail-closed reading — treating it as "no cap" would silently turn the
  // safest-looking input into the widest one.
  const allowedScopesParse =
    candidate.allowedScopes === undefined ? null : ALLOWED_SCOPES.safeParse(candidate.allowedScopes);
  if (allowedScopesParse !== null && !allowedScopesParse.success) {
    errors.push({ code: 'invalid_allowed_scopes', field: 'allowedScopes' });
  } else if (allowedScopesParse !== null) {
    const seen = new Set<string>();
    allowedScopesParse.data.forEach((scope: unknown, index: number) => {
      const field = `allowedScopes[${index}]`;
      if (typeof scope !== 'string') {
        errors.push({ code: 'unknown_scope', field, scope: NON_STRING_PLACEHOLDER });
        return;
      }
      const problem = classifyScopeShape(scope);
      if (problem === 'forbidden') {
        errors.push({ code: 'forbidden_scope', field, scope });
        return;
      }
      if (problem === 'unknown') {
        errors.push({ code: 'unknown_scope', field, scope });
        return;
      }
      if (seen.has(scope)) {
        errors.push({ code: 'duplicate_scope', field, scope });
        return;
      }
      seen.add(scope);
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Rebuilt field by field rather than spread, so nothing the caller did not
  // ask for — `firstParty`, `verified`, an id — can ride in on the object.
  const value: ClientRegistration = {
    name: candidate.name as string,
    redirectUris: acceptedRedirectUris,
  };
  if (candidate.description !== undefined) value.description = candidate.description as string;
  if (candidate.logoUrl !== undefined) value.logoUrl = candidate.logoUrl as string;
  if (candidate.homepageUrl !== undefined) value.homepageUrl = candidate.homepageUrl as string;
  if (allowedScopesParse !== null && allowedScopesParse.success) {
    value.allowedScopes = allowedScopesParse.data as string[];
  }
  return { ok: true, value };
}
