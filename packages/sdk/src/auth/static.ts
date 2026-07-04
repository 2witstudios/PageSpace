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
 * The token is held in a private class field, which util.inspect/JSON.stringify
 * never surface — logging or serializing this provider cannot leak it.
 */
import { AuthenticationError } from '../errors.js';
import type { AuthProvider } from './provider.js';

export class StaticTokenProvider implements AuthProvider {
  readonly #token: string;
  #invalidated = false;

  constructor(token: string) {
    this.#token = token;
  }

  async getAccessToken(): Promise<string> {
    if (this.#invalidated) {
      this.#invalidated = false;
      throw new AuthenticationError('Static token was invalidated and has no refresh path; re-issue a new credential');
    }
    return this.#token;
  }

  invalidate(): void {
    this.#invalidated = true;
  }
}
