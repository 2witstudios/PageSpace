/**
 * Durable, scoped approvals — the pure matcher (GA wave 2, leaf 2).
 *
 * WHAT AN APPROVAL IS FOR. Before this wave the daemon remembered an `ask`
 * answer under `(userId, sessionId, op)`: approving `git status` silently
 * authorized every later `exec` in that session, unseen, and a new chat asked
 * again. Both halves were wrong. An approval is now keyed on
 *
 *     (envId, userId, op, subject)
 *
 * where the SUBJECT is the thing the owner actually looked at: for `exec`, the
 * resolved program (`exec:/usr/bin/git`); for `fs_read` and an ordinary
 * `fs_write`, the policy root the paths resolve inside (`root:/home/u/proj`);
 * for an fs_write the classifier escalated, the specific FILE
 * (`file:/home/u/proj/.git/hooks/pre-commit`, hardening A3) — approving one
 * git hook must never cover every future write under that root. Never a
 * session, never a conversation. Approving `git status` covers `git push` from
 * a new chat tomorrow and does NOT cover `rm -rf`.
 *
 * `sh -c <script>`. The bash tool always sends `sh -c "<command line>"`, so
 * the program is not `sh` — it is every program the script names. The lexer
 * below (`shellCommandWords`) splits the script on the shell's list and pipe
 * operators, drops env assignments, wrappers and control keywords, and keys
 * on EACH command word. A script is covered only when EVERY word is. Anything
 * the lexer cannot attribute to a program name — substitution, `eval`, a
 * nested shell, `find -exec`, a quoted or variable command word — yields NO
 * subject: such a request is asked about every time, and an approval can
 * never be written for it. The shell itself is never a subject.
 *
 * Fail closed, by construction: an unresolvable subject is `ask`; an
 * approvals file with ANY defect parses to `null` (empty), never partially.
 *
 * Pure: the program resolver (PATH walk) and the clock are injected; there is
 * no I/O here. Consulted by `decideExecution` AFTER `confinePath` and
 * `scrubEnv`, so a match is against the normalised request and a retargeted
 * symlink cannot ride an old approval.
 */
import { z } from 'zod';
import { GRANT_OPS, type Grant, type GrantOp } from './grant';
import type { NormalizedRequest } from './decide-execution';
import { sensitiveWrites } from './classify-write';

export const APPROVAL_SCOPES = ['once', 'session', '30d', 'until_revoked'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];
export const DEFAULT_APPROVAL_SCOPE: ApprovalScope = '30d';
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The scopes that reach `~/.pagespace/env-approvals.json`; `once` is never remembered, `session` lives in the daemon process only. */
export const DURABLE_APPROVAL_SCOPES = ['30d', 'until_revoked'] as const satisfies readonly ApprovalScope[];
export type DurableApprovalScope = (typeof DURABLE_APPROVAL_SCOPES)[number];

export function isDurableScope(scope: ApprovalScope): scope is DurableApprovalScope {
  return (DURABLE_APPROVAL_SCOPES as readonly ApprovalScope[]).includes(scope);
}

/** When an approval of `scope` granted at `now` stops covering; `null` = no expiry of its own. */
export function approvalExpiry(scope: ApprovalScope, now: number): number | null {
  return scope === '30d' ? now + THIRTY_DAYS_MS : null;
}

/**
 * One row of the approvals file (or of the daemon's in-memory session set).
 * `approvalId` is shared by every subject row one click produced, so the
 * server can revoke "that approval" by the id it knows (the challenge id).
 */
export interface DurableApproval {
  readonly approvalId: string;
  readonly envId: string;
  readonly userId: string;
  readonly op: GrantOp;
  /** `exec:<resolved program>`, `builtin:<name>`, `root:<policy root>`, or `file:<path>` for a sensitive write (A3). */
  readonly subject: string;
  readonly scope: ApprovalScope;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface ApprovalMatchDeps {
  /** The daemon's PATH walk (`command-resolver.ts`): absolute path of a program, or `null`. */
  readonly resolveArgv0: (name: string) => string | null;
  /** The machine policy's roots — the subjects of file operations. */
  readonly roots: readonly string[];
  /**
   * The mode a file already has, for deciding whether an `fs_write` is
   * sensitive and therefore keyed on the FILE rather than the root. The same
   * (memoised) probe `decideExecution` classifies with, so the subject and the
   * escalation can never disagree about one request. See `classify-write.ts`.
   */
  readonly statMode?: (path: string) => number | null;
}

export type ApprovalMatch = 'covered' | 'ask' | 'expired';

// ---- shell lexing -----------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const BUILTINS = new Set(['cd', 'echo', 'export', 'pwd', 'true', 'false', 'test', '[', 'set', 'unset', 'printf', 'read', 'exit', 'return', 'shift', 'wait', 'type', 'alias', 'umask', 'ulimit', 'trap', 'hash', 'times', 'getopts', 'let', 'local', 'readonly', ':']);
/** Words after which the next word is the command: a wrapper we look through. */
const WRAPPERS = new Set(['env', 'nohup', 'time', 'nice', 'timeout', 'command', 'builtin']);
/** Words that run something we cannot see: never a subject. */
const OPAQUE = new Set(['eval', 'exec', 'source', '.', 'xargs', 'sudo', 'doas', 'su', 'watch', 'case', ...SHELLS]);
/** Control keywords that precede a command on the same segment. */
const PRECEDING_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '(']);
/** Segments that are pure syntax, not commands. */
const BARE_KEYWORDS = new Set(['fi', 'done', 'esac', 'then', 'else', 'do', '}', ')']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Trim every trailing character that is in `chars`, by a backwards walk —
 * never a `[…]+$` regex, which is polynomial on a long run of the character
 * (CodeQL js/polynomial-redos on #2583; the script is agent-supplied).
 */
export function trimTrailing(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1] as string)) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Split a script into command segments on `; && || | & \n`, honouring quotes and backslashes. Substitution ⇒ null. */
function splitSegments(script: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i] as string;
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < script.length) {
        current += ch + script[i + 1];
        i += 1;
        continue;
      }
      // Double quotes do NOT stop substitution (Codex P1 on #2583): `"$(…)"`,
      // `"\`…\`"` and `"${…}"` run commands exactly as they would unquoted, so
      // they are opaque here too. Single quotes are literal (POSIX).
      if (quote === '"' && (ch === '`' || (ch === '$' && (script[i + 1] === '(' || script[i + 1] === '{')))) return null;
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      current += ch + script[i + 1];
      i += 1;
      continue;
    }
    if (ch === '`') return null;
    if (ch === '$' && (script[i + 1] === '(' || script[i + 1] === '{')) return null;
    if ((ch === '<' || ch === '>') && script[i + 1] === '(') return null;
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // `2>&1`, `>&2`, `<&0`: a duplicated descriptor, not a background operator.
    if (ch === '&' && (script[i - 1] === '>' || script[i - 1] === '<')) {
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  segments.push(current);
  return segments;
}

/** Whitespace-separated words of one segment, quotes kept on the word so a quoted command word is detectable. */
function words(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      if (current.length > 0) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * The command word of every simple command in a shell script, in order —
 * or `null` when any part of it cannot be attributed to a program name.
 * Conservative on purpose: this decides what a durable approval COVERS, so
 * "I am not sure" must mean "ask", never "assume".
 */
export function shellCommandWords(script: string): string[] | null {
  const segments = splitSegments(script);
  if (segments === null) return null;
  const out: string[] = [];
  for (const segment of segments) {
    let tokens = words(segment.trim());
    // Grouping and control keywords that precede the command on this segment.
    while (tokens.length > 0) {
      const head = tokens[0] as string;
      if (PRECEDING_KEYWORDS.has(head)) {
        tokens = tokens.slice(1);
        continue;
      }
      // `(cmd` / `{cmd` / `!cmd` without a space.
      if ((head.startsWith('(') || head.startsWith('{') || head.startsWith('!')) && head.length > 1) {
        tokens = [head.slice(1), ...tokens.slice(1)];
        continue;
      }
      break;
    }
    // Trailing `)` / `}` on the last word, or as its own word.
    tokens = tokens.filter((token) => !BARE_KEYWORDS.has(token)).map((token) => trimTrailing(token, ')}')).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    // `for x in …` names no program on its own segment; `case` is opaque (handled below).
    if (tokens[0] === 'for' || tokens[0] === 'select' || tokens[0] === 'function') continue;
    // Env assignments and wrappers, repeatedly (`env FOO=1 nohup git …`).
    let index = 0;
    for (;;) {
      const token = tokens[index];
      if (token === undefined) break;
      if (ENV_ASSIGNMENT.test(token)) {
        index += 1;
        continue;
      }
      if (WRAPPERS.has(token)) {
        index += 1;
        // Skip the wrapper's own options (`timeout 5`, `nice -n 5` are approximated: any leading `-option` word).
        while (tokens[index] !== undefined && (tokens[index] as string).startsWith('-')) index += 1;
        if (token === 'timeout' && tokens[index] !== undefined && /^\d/.test(tokens[index] as string)) index += 1;
        continue;
      }
      break;
    }
    const word = tokens[index];
    if (word === undefined) continue; // assignments only: no program runs
    if (word.startsWith('"') || word.startsWith("'") || word.includes('$') || word.includes('`')) return null;
    const name = word.startsWith('\\') ? word.slice(1) : word;
    if (OPAQUE.has(name) || OPAQUE.has(basename(name))) return null;
    if (name === 'find' && tokens.slice(index + 1).some((t) => /^-(exec|execdir|ok|okdir|delete)$/.test(t))) return null;
    out.push(name);
  }
  return out.length === 0 ? null : out;
}

// ---- subjects ---------------------------------------------------------------

function isInsideRoot(path: string, root: string): boolean {
  const base = trimTrailing(root, '/');
  return path === base || path.startsWith(`${base}/`);
}

function programSubject(name: string, deps: ApprovalMatchDeps): string | null {
  if (BUILTINS.has(name)) return `builtin:${name}`;
  const resolved = deps.resolveArgv0(name);
  return resolved === null ? null : `exec:${resolved}`;
}

/**
 * The subjects a request is keyed on, or `null` when it has none it could be
 * durably approved under (the request is then asked about every time).
 */
export function approvalSubjects(request: NormalizedRequest, deps: ApprovalMatchDeps): readonly string[] | null {
  switch (request.op) {
    case 'exec': {
      const cmd = request.cmd;
      if (cmd === undefined || cmd.length === 0) return null;
      const args = request.args ?? [];
      const shellName = basename(cmd);
      if (SHELLS.has(shellName)) {
        // Only the `-c <script>` form is understood; any other way of driving a shell is opaque.
        const script = args[0] === '-c' ? args[1] : args[0] === '-lc' || args[0] === '-ec' ? args[1] : undefined;
        if (script === undefined || args.length !== 2) return null;
        const names = shellCommandWords(script);
        if (names === null) return null;
        const subjects: string[] = [];
        for (const name of names) {
          const subject = programSubject(name, deps);
          if (subject === null) return null;
          if (!subjects.includes(subject)) subjects.push(subject);
        }
        return subjects;
      }
      const subject = programSubject(cmd, deps);
      return subject === null ? null : [subject];
    }
    case 'fs_write': {
      // A SENSITIVE write is keyed on the FILE, not the root (hardening A3):
      // approving one git hook must never cover every future write under the
      // same root. When any file in the request is sensitive, EVERY path in it
      // becomes its own subject, so what the approval covers is exactly the
      // set of files the owner was shown.
      if (sensitiveWrites(request.paths, request.writeModes, deps.statMode).length > 0) {
        const subjects: string[] = [];
        for (const path of request.paths) {
          const subject = `file:${path}`;
          if (!subjects.includes(subject)) subjects.push(subject);
        }
        return subjects.length === 0 ? null : subjects;
      }
      return rootSubjects(request.paths, deps);
    }
    case 'fs_read':
      return rootSubjects(request.paths, deps);
    case 'pty_open':
      return null;
    default:
      return null;
  }
}

/** The policy root every path resolves inside — the subject of an ordinary file operation. */
function rootSubjects(paths: readonly string[], deps: ApprovalMatchDeps): readonly string[] | null {
  const subjects: string[] = [];
  for (const path of paths) {
    const root = deps.roots.find((candidate) => isInsideRoot(path, candidate));
    if (root === undefined) return null;
    const subject = `root:${root}`;
    if (!subjects.includes(subject)) subjects.push(subject);
  }
  return subjects.length === 0 ? null : subjects;
}

// ---- matching ---------------------------------------------------------------

export interface ApprovalCoverage {
  readonly match: ApprovalMatch;
  /** The subjects the request is keyed on (`null` = unresolvable). */
  readonly subjects: readonly string[] | null;
  /** On `covered`: the approval ids that cover it, for the audit line. */
  readonly approvalIds: readonly string[];
}

/** The full answer; `matchApproval` is its verdict word. */
export function findApprovalCoverage(approvals: readonly DurableApproval[], grant: Grant, request: NormalizedRequest, now: number, deps: ApprovalMatchDeps): ApprovalCoverage {
  const subjects = approvalSubjects(request, deps);
  if (subjects === null || grant.op !== request.op) return { match: 'ask', subjects, approvalIds: [] };
  const ids: string[] = [];
  let expired = false;
  for (const subject of subjects) {
    const candidates = approvals.filter((a) => a.envId === grant.envId && a.userId === grant.principal.userId && a.op === grant.op && a.subject === subject);
    if (candidates.length === 0) return { match: 'ask', subjects, approvalIds: [] };
    const live = candidates.find((a) => a.expiresAt === null || a.expiresAt > now);
    if (live === undefined) {
      expired = true;
      continue;
    }
    if (!ids.includes(live.approvalId)) ids.push(live.approvalId);
  }
  return expired ? { match: 'expired', subjects, approvalIds: [] } : { match: 'covered', subjects, approvalIds: ids };
}

/**
 * Is this normalised request covered by an unexpired approval for every
 * subject it names? `expired` means every subject has an approval but at
 * least one has only expired ones; `ask` means at least one has none (or the
 * request has no subjects at all).
 */
export function matchApproval(approvals: readonly DurableApproval[], grant: Grant, request: NormalizedRequest, now: number, deps: ApprovalMatchDeps): ApprovalMatch {
  return findApprovalCoverage(approvals, grant, request, now, deps).match;
}

// ---- the file ---------------------------------------------------------------

export const APPROVALS_FILE_VERSION = 1;

const approvalRowSchema = z
  .object({
    approvalId: z.string().min(1),
    envId: z.string().min(1),
    userId: z.string().min(1),
    op: z.enum(GRANT_OPS),
    subject: z.string().regex(/^(exec|builtin|root|file):.+$/),
    scope: z.enum(DURABLE_APPROVAL_SCOPES),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .refine((row) => (row.scope === '30d' ? row.expiresAt !== null : row.expiresAt === null), 'expiry must match the scope');

export const approvalsFileSchema = z
  .object({
    version: z.literal(APPROVALS_FILE_VERSION),
    approvals: z.array(approvalRowSchema),
  })
  .strict();

/**
 * Parse the approvals file's contents. `null` for ANY defect — an unknown
 * field, a scope that must never be persisted, an expiry that contradicts its
 * scope, one bad row among good ones — so a damaged file can only ever make
 * the machine ask MORE, never less. Never a partial list.
 */
export function parseApprovalsFile(input: unknown): DurableApproval[] | null {
  const parsed = approvalsFileSchema.safeParse(input);
  return parsed.success ? parsed.data.approvals : null;
}
