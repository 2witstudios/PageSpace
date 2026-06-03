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
 * Resolve an agent-supplied, sandbox-root-relative path to an absolute path
 * inside the sandbox, or `null` if it escapes the root or is otherwise invalid.
 */
export function resolveSandboxPath(userPath: string): string | null {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    return null;
  }
  return resolvePathWithinSync(SANDBOX_ROOT, userPath);
}
