/**
 * Pure (de)serialization + decision functions for the credential store.
 * No fs/keychain I/O lives here — file-store.ts and keychain.ts are the
 * adapters that call into these functions with data they already fetched.
 */

export interface HostCredential {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
}

export interface CredentialSummary {
  readonly host: string;
  readonly tokenPrefix: string;
}

export interface CredentialsFile {
  readonly version: 1;
  readonly hosts: Readonly<Record<string, HostCredential>>;
}

export class CredentialsFileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsFileFormatError';
  }
}

/** Chars of a refresh token safe to show in `list()`/debug output. Never the full token. */
const TOKEN_PREFIX_LENGTH = 12;

export function tokenPrefix(token: string): string {
  throw new Error('not implemented');
}

export function emptyCredentialsFile(): CredentialsFile {
  throw new Error('not implemented');
}

export function parseCredentialsFile(raw: string): CredentialsFile {
  throw new Error('not implemented');
}

export function serializeCredentialsFile(file: CredentialsFile): string {
  throw new Error('not implemented');
}

export function getHost(file: CredentialsFile, host: string): HostCredential | null {
  throw new Error('not implemented');
}

export function upsertHost(file: CredentialsFile, host: string, credential: HostCredential): CredentialsFile {
  throw new Error('not implemented');
}

export function removeHost(file: CredentialsFile, host: string): CredentialsFile {
  throw new Error('not implemented');
}

export function listSummaries(file: CredentialsFile): readonly CredentialSummary[] {
  throw new Error('not implemented');
}

/** Encodes a single host's credential as the secret string stored in a keychain entry. */
export function serializeHostCredential(credential: HostCredential): string {
  throw new Error('not implemented');
}

export function parseHostCredential(raw: string): HostCredential {
  throw new Error('not implemented');
}

const SECURE_MODE_MASK = 0o077;

/** True iff `mode` (masked to the low 9 bits) has no group/other read/write/execute bits set. */
export function isSecureMode(mode: number): boolean {
  throw new Error('not implemented');
}

export function permissionFixItMessage(path: string, mode: number): string {
  throw new Error('not implemented');
}
