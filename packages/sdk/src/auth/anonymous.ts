/**
 * AnonymousAuthProvider — the credential source for a caller that has none
 * yet: an AI agent about to create its own account (ADR 0008). Unauthenticated
 * operations (`agent.challenge`, `agent.signup`, `agent.claim`) never ask a
 * provider for a token, so they work through it; every other operation fails
 * closed here, before any request is sent.
 */
import { AuthenticationError } from '../errors.js';
import type { AuthProvider } from './provider.js';

export class AnonymousAuthProvider implements AuthProvider {
  readonly canRefresh = false;

  async getAccessToken(): Promise<string> {
    throw new AuthenticationError(
      'This client has no credential. It can call only unauthenticated operations (agent.challenge, agent.signup, agent.claim); ' +
        'exchange the agent secret with exchangeAgentAssertion and build a client with OAuthTokenProvider or StaticTokenProvider for anything else.',
    );
  }

  invalidate(): void {
    // Nothing was ever issued.
  }
}
