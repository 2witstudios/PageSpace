/**
 * Environment scrubbing for commands the server asks the user's machine to run
 * (invariant 4). The server never gets to set environment on the machine except
 * through the owner's allowlist — that allowlist is the real gate. The
 * hard-deny list below is a BACKSTOP behind it, not an exhaustive catalogue: it
 * refuses well-known loader, interpreter, shell, and tool injection hooks even
 * if an owner allowlists them by mistake, because `LD_PRELOAD=/evil.so ls` is
 * code execution regardless of what `ls` is. Anything not on this list still
 * needs to be allowlisted to get through.
 */
import { ENV_NAME_RE } from './policy-types';

/** Names refused unconditionally, grouped by the hook family they represent. */
export const ENV_HARD_DENYLIST: readonly string[] = [
  // command resolution
  'PATH',
  'CDPATH',
  // dynamic loader tunables (glibc)
  'GLIBC_TUNABLES',
  'GCONV_PATH',
  'LOCPATH',
  // shell startup / rc-file hijack
  'HOME',
  'ZDOTDIR',
  'XDG_CONFIG_HOME',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'IFS',
  // runtime option injection
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'JDK_JAVAC_OPTIONS',
  'PERL5DB',
  // tool command / config injection
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  // scratch-location redirection
  'TMPDIR',
];

/**
 * Prefix families refused unconditionally: glibc and macOS dynamic loaders,
 * and bash's exported-function mechanism (Shellshock-style `BASH_FUNC_x%%`).
 */
export const ENV_HARD_DENIED_PREFIXES: readonly string[] = ['LD_', 'DYLD_', 'BASH_FUNC_'];

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
