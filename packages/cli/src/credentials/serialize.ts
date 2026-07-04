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
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

export function emptyCredentialsFile(): CredentialsFile {
  return { version: 1, hosts: {} };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isHostCredential(value: unknown): value is HostCredential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.length > 0 &&
    typeof candidate.clientId === 'string' &&
    candidate.clientId.length > 0 &&
    isStringArray(candidate.scopes) &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0
  );
}

function toHostCredential(value: HostCredential): HostCredential {
  return {
    refreshToken: value.refreshToken,
    clientId: value.clientId,
    scopes: [...value.scopes],
    createdAt: value.createdAt,
  };
}

export function parseCredentialsFile(raw: string): CredentialsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsFileFormatError('Credentials file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CredentialsFileFormatError('Credentials file must contain a JSON object.');
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new CredentialsFileFormatError('Unsupported or missing credentials file "version".');
  }
  if (typeof candidate.hosts !== 'object' || candidate.hosts === null) {
    throw new CredentialsFileFormatError('Credentials file is missing a "hosts" object.');
  }

  const hosts: Record<string, HostCredential> = {};
  for (const [host, value] of Object.entries(candidate.hosts as Record<string, unknown>)) {
    if (!isHostCredential(value)) {
      throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is malformed.`);
    }
    hosts[host] = toHostCredential(value);
  }

  return { version: 1, hosts };
}

export function serializeCredentialsFile(file: CredentialsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function getHost(file: CredentialsFile, host: string): HostCredential | null {
  return file.hosts[host] ?? null;
}

export function upsertHost(file: CredentialsFile, host: string, credential: HostCredential): CredentialsFile {
  return { version: 1, hosts: { ...file.hosts, [host]: toHostCredential(credential) } };
}

export function removeHost(file: CredentialsFile, host: string): CredentialsFile {
  const hosts = { ...file.hosts };
  delete hosts[host];
  return { version: 1, hosts };
}

export function listSummaries(file: CredentialsFile): readonly CredentialSummary[] {
  return Object.entries(file.hosts)
    .map(([host, credential]) => ({ host, tokenPrefix: tokenPrefix(credential.refreshToken) }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/** Encodes a single host's credential as the secret string stored in a keychain entry. */
export function serializeHostCredential(credential: HostCredential): string {
  return JSON.stringify(toHostCredential(credential));
}

export function parseHostCredential(raw: string): HostCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsFileFormatError('Keychain secret is not valid JSON.');
  }
  if (!isHostCredential(parsed)) {
    throw new CredentialsFileFormatError('Keychain secret is malformed.');
  }
  return toHostCredential(parsed);
}

const SECURE_MODE_MASK = 0o077;

/** True iff `mode` (masked to the low 9 bits) has no group/other read/write/execute bits set. */
export function isSecureMode(mode: number): boolean {
  return (mode & SECURE_MODE_MASK) === 0;
}

export function permissionFixItMessage(path: string, mode: number): string {
  const octal = (mode & 0o777).toString(8).padStart(3, '0');
  return (
    `Refusing to read credentials file at ${path}: mode ${octal} is readable by group/other. ` +
    `Fix with: chmod 600 ${path}`
  );
}
