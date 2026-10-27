/**
 * StaticTokenProvider (ADR 0003 §4; Phase 2 task 4).
 *
 * Wraps a fixed credential (mcp_* token, PAGESPACE_TOKEN) that is "used
 * exactly as given: never refreshed, never written to the profile store"
 * (ADR 0003 §4). There is no refresh path, so invalidate() has nothing to
 * recover into — it fails closed on the very next call rather than replaying
 * a token the caller just told us was rejected. That failure is one-shot,
 * not sticky: a single 401 can be transient (a momentary server hiccup, not
 * proof the token is truly dead), so the flag clears itself as soon as it's
 * consumed. Without this, one transient rejection would brick every later
 * call for the rest of a long-lived process (e.g. an MCP server) even
 * though the token was never actually revoked.
 *
 * `canRefresh: false` (see AuthProvider) keeps PageSpaceClient's auth retry
 * away from this provider entirely, so the branch below is now reached only
 * by a caller that invalidates and retries by hand. That matters because a
 * 401 does NOT prove the token is dead: `/api/auth/mcp-tokens` answers a
 * perfectly live mcp_* key with "MCP tokens are not permitted for this
 * endpoint" — a refusal of the credential CLASS, not of the credential — and
 * the retry used to overwrite exactly that message with this one (#2464).
 * The wording below no longer claims to know which it was.
 *
 * The token is held in a private class field, which util.inspect/JSON.stringify
 * never surface — logging or serializing this provider cannot leak it.
 */
import { AuthenticationError } from '../errors.js';
import type { AuthProvider } from './provider.js';

export class StaticTokenProvider implements AuthProvider {
  readonly canRefresh = false;
  readonly #token: string;
  #invalidated = false;

  constructor(token: string) {
    this.#token = token;
  }

  async getAccessToken(): Promise<string> {
    if (this.#invalidated) {
      this.#invalidated = false;
      throw new AuthenticationError(
        'The last request with this static token was refused, and a static token has no refresh path to retry with. ' +
          'That refusal does not necessarily mean the token is invalid — an endpoint may simply not accept this ' +
          'credential type. Check the refusal the server actually returned before re-issuing the credential.',
      );
    }
    return this.#token;
  }

  invalidate(): void {
    this.#invalidated = true;
  }
}
