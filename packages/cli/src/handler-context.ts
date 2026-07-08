import type { PageSpaceClient } from '@pagespace/sdk';
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
  /** The host → active-key-name map (`pagespace keys use`) — read by `whoami`, written by `keys use`. */
  readonly activeKeyStore: ActiveKeyStore;
  /** Whether stdin is an interactive terminal — governs the fail-closed rule for destructive verbs. */
  readonly isTTY: boolean;
  /** Writes `message` and reads one line of interactive input. Never called when `isTTY` is false. */
  readonly prompt: (message: string) => Promise<string>;
}
