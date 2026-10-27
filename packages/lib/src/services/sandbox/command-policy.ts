/**
 * Inline command policy for the `bash` tool (pure).
 *
 * The microVM's deny-all egress firewall (see `egress.ts`) is the real network
 * boundary — this policy is a cheap, fail-closed pre-check applied INLINE in the
 * tool's `execute` BEFORE the command ever reaches `runCommand`. It exists to:
 *
 *  - Reject empty / oversized input early (abuse + DoS guard), and
 *  - Block the few command shapes that are categorically not ours to run —
 *    notably any reference to the cloud metadata endpoint `169.254.169.254`
 *    (SSRF/credential-theft defence in depth, layered on top of egress deny).
 *
 * It never tries to be a sandbox-escape detector by string-matching arbitrary
 * shell — that is unwinnable and security theatre; isolation + egress own that.
 * The command is passed to the sandbox as a structured arg array
 * (`runCommand({ cmd: 'sh', args: ['-c', command] })`), never concatenated into a
 * host-side shell string, so this function only decides allow / block.
 *
 * Every regex here is a single linear scan (literal substrings, one bounded
 * character class) — no nested or overlapping quantifiers — so agent-supplied
 * input can never trigger polynomial backtracking (CodeQL js/polynomial-redos).
 */

/** Hard cap on a single submitted command, in bytes. */
export const MAX_COMMAND_BYTES = 16 * 1024;

export type CommandPolicyDenialReason =
  | 'empty_command'
  | 'command_too_large'
  | 'blocked_metadata_access'
  | 'github_over_bash';

export type CommandPolicyDecision =
  | { ok: true }
  | { ok: false; reason: CommandPolicyDenialReason };

// The IPv4 link-local metadata address and its common decimal/hex encodings.
// Each alternative is a fixed literal — the alternation is linear.
const METADATA_ADDRESS = /169\.254\.169\.254|0xa9fea9fe|2852039166/i;

// The `gh` CLI (any subcommand) or git's auth-requiring subcommands run in `bash`,
// which carries NO GitHub credentials — only the dedicated git_*/gh_* tools do.
// This is a UX redirect to those tools, NOT a security control (isolation + egress
// own security; see this file's header). Anchored to a command-start boundary
// (start of string, or just after `;`/`&`/`|`/newline) to limit false positives,
// and local credential-free git (status/diff/log/add/commit) is intentionally NOT
// matched. The trailing `(?![\w-])` requires the command token to end, so `github`
// and `git pushy` do not match. One linear scan — no nested/overlapping
// quantifiers (CodeQL js/polynomial-redos safe).
const GITHUB_OVER_BASH = /(?:^|[\n;&|])[ \t]*(?:gh|git[ \t]+(?:clone|fetch|pull|push))(?![\w-])/i;

const deny = (reason: CommandPolicyDenialReason): CommandPolicyDecision => ({
  ok: false,
  reason,
});

export function evaluateCommandPolicy({
  command = '',
  maxBytes = MAX_COMMAND_BYTES,
}: {
  command?: string;
  maxBytes?: number;
} = {}): CommandPolicyDecision {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return deny('empty_command');
  }
  if (Buffer.byteLength(command, 'utf8') > maxBytes) {
    return deny('command_too_large');
  }
  if (METADATA_ADDRESS.test(command)) {
    return deny('blocked_metadata_access');
  }
  if (GITHUB_OVER_BASH.test(command)) {
    return deny('github_over_bash');
  }
  return { ok: true };
}
