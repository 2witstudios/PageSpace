import type { PageSpaceClient } from '@pagespace/sdk';
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
}
