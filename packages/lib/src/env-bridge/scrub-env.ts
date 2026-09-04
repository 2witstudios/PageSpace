/**
 * Environment scrubbing for commands the server asks the user's machine to run
 * (invariant 4). The server never gets to set environment on the machine except
 * through the owner's allowlist — and even an allowlisted name is refused if it
 * is a loader or interpreter hook, because `LD_PRELOAD=/evil.so ls` is code
 * execution regardless of what `ls` is.
 */
import { ENV_NAME_RE } from './policy-types';

/** Names refused unconditionally: dynamic-loader and interpreter injection hooks. */
export const ENV_HARD_DENYLIST: readonly string[] = [
  'PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'IFS',
];

/** Prefix families refused unconditionally (glibc and macOS dynamic loaders). */
export const ENV_HARD_DENIED_PREFIXES: readonly string[] = ['LD_', 'DYLD_'];

export function isHardDeniedEnvVar(name: string): boolean {
  return ENV_HARD_DENYLIST.includes(name) || ENV_HARD_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Keep only allowlisted, well-formed, non-hooking variables with clean string
 * values. Returns a fresh object; the input is never mutated.
 */
export function scrubEnv(requested: Readonly<Record<string, string>> | undefined, allowlist: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!requested) return out;
  const allowed = new Set(allowlist);
  for (const [name, value] of Object.entries(requested)) {
    if (!ENV_NAME_RE.test(name)) continue;
    if (isHardDeniedEnvVar(name)) continue;
    if (!allowed.has(name)) continue;
    if (typeof value !== 'string') continue;
    if (value.includes('\0')) continue;
    out[name] = value;
  }
  return out;
}
