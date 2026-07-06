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

/**
 * The parse/migrate constructors below build objects via `Object.fromEntries`
 * rather than `hosts[key] = value` assignment: JSON keys are arbitrary
 * strings, and assigning to a key named `__proto__` would silently set the
 * object's prototype instead of creating the own data property the lookup
 * functions above (`Object.hasOwn`) expect.
 */

/** Validates + copies a raw v1 `hosts` object (one unnamed credential per host). */
function parseHostsV1(rawHosts: Record<string, unknown>): Record<string, HostCredential> {
  return Object.fromEntries(
    Object.entries(rawHosts).map(([host, value]) => {
      if (!isHostCredential(value)) {
        throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is malformed.`);
      }
      return [host, toHostCredential(value)];
    }),
  );
}

/** Pure: folds each v1 host credential into that host's "default" profile. */
function migrateHostsV1ToV2(hostsV1: Readonly<Record<string, HostCredential>>): Record<string, HostProfiles> {
  return Object.fromEntries(
    Object.entries(hostsV1).map(([host, credential]) => [host, { profiles: { [DEFAULT_PROFILE_NAME]: credential } }]),
  );
}

/** Validates + copies a raw v2 `hosts` object (nested `{ profiles: { [name]: HostCredential } }`). */
function parseHostsV2(rawHosts: Record<string, unknown>): Record<string, HostProfiles> {
  return Object.fromEntries(
    Object.entries(rawHosts).map(([host, value]) => {
      if (typeof value !== 'object' || value === null) {
        throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is malformed.`);
      }
      const rawProfiles = (value as Record<string, unknown>).profiles;
      if (typeof rawProfiles !== 'object' || rawProfiles === null) {
        throw new CredentialsFileFormatError(`Credentials file entry for host "${host}" is missing a "profiles" object.`);
      }
      const profiles = Object.fromEntries(
        Object.entries(rawProfiles as Record<string, unknown>).map(([profileName, profileValue]) => {
          if (!isHostCredential(profileValue)) {
            throw new CredentialsFileFormatError(
              `Credentials file entry for host "${host}" profile "${profileName}" is malformed.`,
            );
          }
          return [profileName, toHostCredential(profileValue)];
        }),
      );
      return [host, { profiles }];
    }),
  );
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

/**
 * Every host/profile lookup below is an `Object.hasOwn` check, never a bare
 * bracket/`in` read: profile names are user-supplied (`--profile`,
 * `--save-as-profile`), and a name like `__proto__` or `toString` would
 * otherwise resolve to `Object.prototype` members instead of stored data.
 */
function ownHostProfiles(file: CredentialsFile, host: string): Readonly<Record<string, HostCredential>> | null {
  return Object.hasOwn(file.hosts, host) ? file.hosts[host]!.profiles : null;
}

export function getHost(file: CredentialsFile, host: string, profile: string = DEFAULT_PROFILE_NAME): HostCredential | null {
  const profiles = ownHostProfiles(file, host);
  return profiles !== null && Object.hasOwn(profiles, profile) ? profiles[profile]! : null;
}

export function upsertHost(
  file: CredentialsFile,
  host: string,
  credential: HostCredential,
  profile: string = DEFAULT_PROFILE_NAME,
): CredentialsFile {
  const existingProfiles = ownHostProfiles(file, host) ?? {};
  return {
    version: 2,
    hosts: {
      ...file.hosts,
      [host]: { profiles: { ...existingProfiles, [profile]: toHostCredential(credential) } },
    },
  };
}

export function removeHost(file: CredentialsFile, host: string, profile: string = DEFAULT_PROFILE_NAME): CredentialsFile {
  const existingProfiles = ownHostProfiles(file, host);
  if (existingProfiles === null || !Object.hasOwn(existingProfiles, profile)) {
    return file;
  }

  const remainingProfiles = { ...existingProfiles };
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
    .filter(([, hostProfiles]) => Object.hasOwn(hostProfiles.profiles, profile))
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
