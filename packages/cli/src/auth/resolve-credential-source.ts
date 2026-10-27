/**
 * The ONE place that answers "which credential would this invocation actually
 * use?" — the full precedence chain, effects included: `--token` flag >
 * `PAGESPACE_TOKEN` env > the stored credential for the resolved `--key`/
 * `PAGESPACE_KEY` name > this machine's active key (`pagespace keys use`) >
 * the stored `"default"` login credential > none.
 *
 * The pure precedence rules still live in `resolve.ts` (`hasExplicitCredential`,
 * `resolveKeyName`, `resolveAuth`) and `legacy-token-env.ts` (the deprecated
 * env-name aliases); this module is the thin async shell that performs the two
 * store reads those rules need (`activeKeyStore.getActiveKey`,
 * `credentialStore.get`) and hands back a single resolved record.
 *
 * Extracted from `run.ts`, which previously inlined it — `whoami` reimplemented
 * only the *last* link of the chain (the `"default"` slot) and so reported
 * "Not logged in" on a machine whose every content command worked through an
 * active key. A second implementation of this precedence is exactly the bug;
 * both callers now share this one.
 *
 * Lives in `src/auth/` rather than in a command module deliberately: the
 * `commands/__tests__/single-auth-path.test.ts` tripwire greps command sources
 * for the raw `PAGESPACE_TOKEN`/`PAGESPACE_KEY` literals precisely so that no
 * command grows its own env read.
 */
import type { ActiveKeyStore } from '../credentials/active-key.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import type { HostCredential } from '../credentials/serialize.js';
import type { CredentialStore } from '../credentials/store.js';
import { resolveEnvKeyName, resolveEnvToken } from './legacy-token-env.js';
import { hasExplicitCredential, resolveAuth, resolveKeyName, type AuthSource } from './resolve.js';

export interface ResolveCredentialSourceInput {
  readonly flags: { readonly token?: string; readonly key?: string };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly host: string;
  readonly credentialStore: Pick<CredentialStore, 'get'>;
  readonly activeKeyStore: Pick<ActiveKeyStore, 'getActiveKey'>;
  /**
   * Whether this invocation may fall back to the machine's active key. `run.ts`
   * passes `false` for auth-exempt handlers (the `keys` family needs the
   * `manage_keys` scope a drive-scoped active key doesn't carry) and for
   * `pagespace mcp` (invoked unattended; its config must name a credential
   * itself). `whoami` passes `true` — its entire job is reporting what a
   * content command on this machine would authenticate as.
   */
  readonly allowActiveKey: boolean;
}

export interface ResolvedCredentialSource {
  /** The resolved source, ready for `buildAuthProvider`. */
  readonly source: AuthSource;
  /** The key name the credential was (or would be) read from. */
  readonly keyName: string;
  /** Non-null only when the active key is what supplied the credential. */
  readonly activeKeyName: string | null;
  /** True when `--token`/`--key`/either env var named a credential explicitly. */
  readonly explicit: boolean;
}

export async function resolveCredentialSource(
  input: ResolveCredentialSourceInput,
): Promise<ResolvedCredentialSource> {
  const { flags, env, host, credentialStore, activeKeyStore, allowActiveKey } = input;

  const envToken = resolveEnvToken(env);
  const envKey = resolveEnvKeyName(env);
  const explicit = hasExplicitCredential({ token: flags.token, key: flags.key }, env);

  const keyNameFromFlags = resolveKeyName({ key: flags.key }, { PAGESPACE_KEY: envKey.name });

  // A bearer token given directly outranks anything on disk, so resolving it
  // needs no store read at all. Worth short-circuiting rather than reading and
  // discarding: on macOS a credential-store read is a native keychain call
  // that can surface an access prompt, and this resolver now runs for every
  // invocation of every command.
  const directToken = flags.token?.trim() || envToken.token?.trim();
  if (directToken) {
    return {
      source: resolveAuth({ token: flags.token }, { PAGESPACE_TOKEN: envToken.token }, {}, host, keyNameFromFlags),
      keyName: keyNameFromFlags,
      activeKeyName: null,
      explicit,
    };
  }

  let keyName = keyNameFromFlags;
  let credential: HostCredential | null = null;
  let activeKeyName: string | null = null;

  if (!explicit && allowActiveKey) {
    const active = await activeKeyStore.getActiveKey(host);
    if (active !== null) {
      const activeCredential = await credentialStore.get(host, active);
      if (activeCredential !== null) {
        keyName = active;
        credential = activeCredential;
        activeKeyName = active;
      }
    }
  }
  if (activeKeyName === null) {
    credential = await credentialStore.get(host, keyName);
  }

  const source = resolveAuth(
    { token: flags.token },
    { PAGESPACE_TOKEN: envToken.token },
    credential ? { [host]: { [keyName]: credential } } : {},
    host,
    keyName,
  );

  return { source, keyName, activeKeyName, explicit };
}

/**
 * Human-readable one-liner naming where the resolved credential came from —
 * display copy for `whoami`. Pure. Deliberately routed through
 * `TOKEN_ENV_VAR_NAME`-free wording: the caller is a command module, and the
 * `single-auth-path.test.ts` tripwire must stay sharp there.
 */
export function describeCredentialSource(
  resolved: Pick<ResolvedCredentialSource, 'source' | 'keyName' | 'activeKeyName'>,
  tokenEnvVarName: string,
): string {
  switch (resolved.source.kind) {
    case 'flag':
      return '--token flag';
    case 'env':
      return `${tokenEnvVarName} environment variable`;
    case 'stored':
      if (resolved.activeKeyName !== null) return `active key "${resolved.activeKeyName}"`;
      if (resolved.keyName === DEFAULT_PROFILE_NAME) return 'personal login';
      return `key "${resolved.keyName}"`;
    case 'none':
      return 'none';
  }
}
