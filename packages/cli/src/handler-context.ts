import type { PageSpaceClient } from '@pagespace/sdk';
import type { CredentialKind } from './auth/credential-kind.js';
import type { AuthSource } from './auth/resolve.js';
import type { ActiveKeyStore } from './credentials/active-key.js';
import type { CredentialStore } from './credentials/store.js';

/** Minimal write sink handlers use instead of touching `process.stdout`/`process.stderr` directly. */
export interface OutputSink {
  write(chunk: string): void;
}

/** Everything a command handler needs, injected — no handler reads `process.*` directly. */
export interface HandlerContext {
  readonly sdk: PageSpaceClient;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialStore: CredentialStore;
  /**
   * What CLASS of credential `ctx.sdk` is authenticating with — a scoped access
   * key, a personal login, an unrecognized bearer, or nothing. The secret-free
   * projection of `run.ts`'s resolved `AuthSource`: enough for a command to
   * refuse accurately BEFORE a round trip the server can only answer with a
   * refusal (see `auth/credential-kind.ts`), never enough to read a token.
   */
  readonly credentialKind: CredentialKind;
  /**
   * WHICH precedence source (`flag` > `env` > `stored` > `none`) resolved the
   * credential — secret-free (just the tag, never a token or a stored key
   * name). Lets a refusal built on `credentialKind` (e.g.
   * `keysCommandNeedsLoginMessage`) name the actual flag/env-var/stored-key
   * to remove instead of guessing one the caller never passed.
   */
  readonly credentialSourceKind: AuthSource['kind'];
  /** The host → active-key-name map (`pagespace keys use`) — read by `whoami`, written by `keys use`. */
  readonly activeKeyStore: ActiveKeyStore;
  /** Whether stdin is an interactive terminal — governs the fail-closed rule for destructive verbs. */
  readonly isTTY: boolean;
  /** Writes `message` and reads one line of interactive input. Never called when `isTTY` is false. */
  readonly prompt: (message: string) => Promise<string>;
}
