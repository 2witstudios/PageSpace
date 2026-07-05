/**
 * Pure (de)serialization + decision functions for the credential store.
 * No fs/keychain I/O lives here — file-store.ts and keychain.ts are the
 * adapters that call into these functions with data they already fetched.
 *
 * Schema v2 nests a `profiles` map under each host so a personal login and
 * one or more named scoped-token profiles can coexist for the same host
 * (Phase 8 task 3). A v1 file (one unnamed credential per host) is migrated
 * automatically and losslessly on read: each `hosts[host]` becomes
 * `hosts[host].profiles.default` — every existing caller that never passes
 * a profile name keeps reading/writing that same "default" profile, so
 * this is a zero-behavior-change migration for existing users.
 */

export const DEFAULT_PROFILE_NAME = 'default';

export interface HostCredential {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
}

export interface HostProfiles {
  readonly profiles: Readonly<Record<string, HostCredential>>;
}

export interface CredentialSummary {
  readonly host: string;
  readonly tokenPrefix: string;
}

export interface CredentialsFile {
  readonly version: 2;
  readonly hosts: Readonly<Record<string, HostProfiles>>;
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
  return { version: 2, hosts: {} };
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

/** Validates + copies a raw v1 `hosts` object (one unnamed credential per host). */
function parseHostsV1(rawHosts: Record<string, unknown>): Record<string, HostCredential> {
  const hosts: Record<string, HostCredential> = {};
  for (const [host, value] of Object.entries(rawHosts)) {
    if (!isHostCredential(value)) {
      throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is malformed.`);
    }
    hosts[host] = toHostCredential(value);
  }
  return hosts;
}

/** Pure: folds each v1 host credential into that host's "default" profile. */
function migrateHostsV1ToV2(hostsV1: Readonly<Record<string, HostCredential>>): Record<string, HostProfiles> {
  const hosts: Record<string, HostProfiles> = {};
  for (const [host, credential] of Object.entries(hostsV1)) {
    hosts[host] = { profiles: { [DEFAULT_PROFILE_NAME]: credential } };
  }
  return hosts;
}

/** Validates + copies a raw v2 `hosts` object (nested `{ profiles: { [name]: HostCredential } }`). */
function parseHostsV2(rawHosts: Record<string, unknown>): Record<string, HostProfiles> {
  const hosts: Record<string, HostProfiles> = {};
  for (const [host, value] of Object.entries(rawHosts)) {
    if (typeof value !== 'object' || value === null) {
      throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is malformed.`);
    }
    const rawProfiles = (value as Record<string, unknown>).profiles;
    if (typeof rawProfiles !== 'object' || rawProfiles === null) {
      throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is missing a "profiles" object.`);
    }
    const profiles: Record<string, HostCredential> = {};
    for (const [profileName, profileValue] of Object.entries(rawProfiles as Record<string, unknown>)) {
      if (!isHostCredential(profileValue)) {
        throw new CredentialsFileFormatError(
          `Credentials file entry for host "${host}" profile "${profileName}" is malformed.`,
        );
      }
      profiles[profileName] = toHostCredential(profileValue);
    }
    hosts[host] = { profiles };
  }
  return hosts;
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
  if (candidate.version !== 1 && candidate.version !== 2) {
    throw new CredentialsFileFormatError('Unsupported or missing credentials file "version".');
  }
  if (typeof candidate.hosts !== 'object' || candidate.hosts === null) {
    throw new CredentialsFileFormatError('Credentials file is missing a "hosts" object.');
  }

  const rawHosts = candidate.hosts as Record<string, unknown>;
  const hosts = candidate.version === 1 ? migrateHostsV1ToV2(parseHostsV1(rawHosts)) : parseHostsV2(rawHosts);

  return { version: 2, hosts };
}

export function serializeCredentialsFile(file: CredentialsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function getHost(file: CredentialsFile, host: string, profile: string = DEFAULT_PROFILE_NAME): HostCredential | null {
  return file.hosts[host]?.profiles[profile] ?? null;
}

export function upsertHost(
  file: CredentialsFile,
  host: string,
  credential: HostCredential,
  profile: string = DEFAULT_PROFILE_NAME,
): CredentialsFile {
  const existingProfiles = file.hosts[host]?.profiles ?? {};
  return {
    version: 2,
    hosts: {
      ...file.hosts,
      [host]: { profiles: { ...existingProfiles, [profile]: toHostCredential(credential) } },
    },
  };
}

export function removeHost(file: CredentialsFile, host: string, profile: string = DEFAULT_PROFILE_NAME): CredentialsFile {
  const existing = file.hosts[host];
  if (!existing || !(profile in existing.profiles)) {
    return file;
  }

  const remainingProfiles = { ...existing.profiles };
  delete remainingProfiles[profile];

  const hosts = { ...file.hosts };
  if (Object.keys(remainingProfiles).length === 0) {
    delete hosts[host];
  } else {
    hosts[host] = { profiles: remainingProfiles };
  }
  return { version: 2, hosts };
}

/** Lists every host that has the given profile stored (defaults to "default") — never the full token. */
export function listSummaries(file: CredentialsFile, profile: string = DEFAULT_PROFILE_NAME): readonly CredentialSummary[] {
  return Object.entries(file.hosts)
    .filter(([, hostProfiles]) => profile in hostProfiles.profiles)
    .map(([host, hostProfiles]) => ({ host, tokenPrefix: tokenPrefix(hostProfiles.profiles[profile]!.refreshToken) }))
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
