/**
 * Sandbox filesystem path confinement (pure).
 *
 * `writeFile` / `readFile` accept an agent-supplied path. Every such path is
 * confined to the sandbox working root via the shared `resolvePathWithinSync`
 * validator — which already handles `..` traversal, URL/double-encoding,
 * null-byte injection, and absolute-path escapes — so an agent can never read or
 * write outside the sandbox's own tree (and, since the VM holds no secrets,
 * never anything sensitive even within it). A rejected path returns `null`;
 * callers fail closed.
 */

import { resolvePathWithinSync } from '../../security/path-validator';

/**
 * The sandbox working directory inside the Sprite. All tool file IO and the
 * default `bash` working directory are confined to this root; the driver ensures
 * it exists on provisioning.
 */
export const SANDBOX_ROOT = '/workspace';

/**
 * The directory a node's OWN Sprite clones its repo into. Byte-identical for
 * branches and promoted projects on purpose — every node that owns a Sprite
 * puts its repo in the same place, so `cwd` is a property of "has its own
 * Sprite", not of which tier the node happens to be. Defined HERE (beside
 * SANDBOX_ROOT) so consumers that need only the string — handle derivation,
 * route validators — don't drag the branch/promotion service graphs (git
 * runners, sandbox client, machine host) into their module graph for one
 * constant.
 */
export const BRANCH_REPO_PATH = `${SANDBOX_ROOT}/repo`;
export const PROJECT_REPO_PATH = `${SANDBOX_ROOT}/repo`;

/**
 * Strip a literal, undecoded `/workspace` prefix from `userPath`, tolerating
 * any number of separating slashes (e.g. a doubled `/workspace//x`), and
 * return the root-relative remainder. Returns `userPath` unchanged if it
 * isn't actually rooted at the sandbox root — `/workspace-evil/x` shares a
 * textual prefix but is a different path, not a prefix match, and must still
 * fall through to `resolvePathWithinSync`'s absolute-path rejection.
 */
function stripSandboxRootPrefix(userPath: string): string {
  if (!userPath.startsWith(SANDBOX_ROOT)) {
    return userPath;
  }
  const rest = userPath.slice(SANDBOX_ROOT.length);
  if (rest.length > 0 && !rest.startsWith('/')) {
    return userPath;
  }
  let i = 0;
  while (rest[i] === '/') i++;
  return rest.slice(i);
}

/**
 * Resolve an agent-supplied, sandbox-root-relative path to an absolute path
 * inside the sandbox, or `null` if it escapes the root or is otherwise invalid.
 *
 * A literal, undecoded `/workspace` prefix is treated as equivalent to the
 * same relative path — the sandbox root isn't something an absolute path can
 * "escape". Only that exact prefix is special-cased; any other absolute path
 * (or an attempt to smuggle the prefix via encoding) falls through unchanged
 * to `resolvePathWithinSync`, which still rejects it.
 */
export function resolveSandboxPath(userPath: string): string | null {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    return null;
  }
  return resolvePathWithinSync(SANDBOX_ROOT, stripSandboxRootPrefix(userPath));
}
