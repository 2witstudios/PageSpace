/**
 * Durable approvals on the machine — `~/.pagespace/env-approvals.json`
 * (GA wave 2, leaf 1).
 *
 * Before this wave an `ask` answer lived in a `Set` keyed `(userId,
 * sessionId, op)` inside the daemon process: a new chat asked again, and one
 * approval of `git status` covered every later `exec` in that session,
 * unseen. Approvals are now keyed `(envId, userId, op, subject)` — see
 * `decide-approval.ts` for what a subject is — with an expiry the owner
 * chose: `once` (never remembered), `session` (this process only),
 * `30d` (the default) or `until_revoked` (the file, until a revoke).
 *
 * THE FILE IS AUTHORITATIVE FOR ALLOW. The daemon reads approvals from this
 * file and from its own memory, and from nowhere else — never from the
 * server. PageSpace may only REVOKE an approval (over the signed `revoke`
 * frame, by id); it cannot write one. That asymmetry is what makes a
 * compromised server unable to widen what runs here, and it is pinned by
 * `__tests__/invariants.test.ts`.
 *
 * Trust rules are the policy file's, through the SAME one-descriptor adapter
 * (`openPolicyFile`, CWE-367): owned by the daemon's uid, not writable by
 * group or world, opened with `O_NOFOLLOW`. A file that fails any check, or
 * whose contents the strict parser refuses, contributes NOTHING — never a
 * partial list — and is never overwritten by this daemon. The file is
 * re-read at every decision, so an out-of-band edit, chmod or delete takes
 * effect at the next request.
 *
 * Writes are atomic (temp file + rename, 0600) and never throw into the
 * dispatcher: a write that fails leaves the approval in memory for the life
 * of the process and says so.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { approvalExpiry, isDurableScope, parseApprovalsFile, serializeApprovalsFile, type ApprovalScope, type DurableApproval, type GrantOp } from './lib-core.js';
import type { OpenedPolicyFile, PolicyLoadReason } from './policy.js';

export const APPROVALS_FILE_NAME = 'env-approvals.json';
export const APPROVALS_PATH_ENV_VAR = 'PAGESPACE_ENV_APPROVALS';

/** Group or world write bits — the same mask the policy loader uses. */
const WRITABLE_BY_OTHERS_MASK = 0o022;

export interface ApprovalsStoreDeps {
  readonly path: string;
  /** The uid the daemon runs as; the file must be owned by it. */
  readonly uid: number;
  /** ONE open: fstat identity and content together; `null` when missing; throws ⇒ unreadable. */
  readonly open: (path: string) => OpenedPolicyFile | null;
  /** Atomic 0600 write (production: `writeApprovalsFile`). */
  readonly write: (path: string, content: string) => Promise<void>;
  readonly now: () => number;
  readonly log?: (line: string) => void;
}

export interface ApprovalsLoad {
  /** The rows in force from the FILE (never partial: any defect ⇒ `[]`). */
  readonly approvals: readonly DurableApproval[];
  /** Why the file contributed nothing; `null` when it was read. `missing` is the ordinary first state. */
  readonly reason: PolicyLoadReason | null;
}

/** What one owner decision remembers: every subject the request named, under one id, for one scope. */
export interface RememberApprovalInput {
  readonly approvalId: string;
  readonly envId: string;
  readonly userId: string;
  readonly op: GrantOp;
  readonly subjects: readonly string[];
  readonly scope: ApprovalScope;
}

export interface ApprovalsStore {
  /** Durable rows (re-read from the file now) plus this process's session rows. */
  entries(): readonly DurableApproval[];
  /** Re-read the file and say why it was or was not trusted. */
  reload(): ApprovalsLoad;
  /** Remember an owner's decision per its scope. Never throws. */
  remember(input: RememberApprovalInput): Promise<void>;
  /** Delete every row of exactly this approval, file and memory. @returns rows removed. */
  revoke(approvalId: string): Promise<number>;
  /** Drop expired rows from the file. @returns rows removed. */
  prune(now: number): Promise<number>;
}

export function defaultApprovalsPath(env: Readonly<Record<string, string | undefined>>, homedir: string): string {
  const fromEnv = env[APPROVALS_PATH_ENV_VAR]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : `${homedir}/.pagespace/${APPROVALS_FILE_NAME}`;
}

export function createApprovalsStore(deps: ApprovalsStoreDeps): ApprovalsStore {
  /** `session`-scoped rows: this process only. */
  const session: DurableApproval[] = [];
  /** Durable rows the file refused to take (refused file, failed write): this process only, so the click still counts. */
  const unwritten: DurableApproval[] = [];
  const log = deps.log ?? (() => undefined);

  const load = (): ApprovalsLoad => {
    let opened: OpenedPolicyFile | null;
    try {
      opened = deps.open(deps.path);
    } catch {
      return { approvals: [], reason: 'unreadable' };
    }
    if (opened === null) return { approvals: [], reason: 'missing' };
    if (opened.uid !== deps.uid) return { approvals: [], reason: 'wrong_owner' };
    if ((opened.mode & WRITABLE_BY_OTHERS_MASK) !== 0) return { approvals: [], reason: 'writable_by_others' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(opened.content);
    } catch {
      return { approvals: [], reason: 'invalid_json' };
    }
    const approvals = parseApprovalsFile(parsed);
    if (approvals === null) return { approvals: [], reason: 'invalid_schema' };
    return { approvals, reason: null };
  };

  /** Read-merge-write. Refuses to touch a file that exists but is not trusted. @returns whether the file now holds `next`. */
  const writeDurable = async (next: readonly DurableApproval[], loaded: ApprovalsLoad): Promise<boolean> => {
    if (loaded.reason !== null && loaded.reason !== 'missing') {
      log(`not writing ${deps.path}: the existing file is refused (${loaded.reason}); the approval is kept for this process only`);
      return false;
    }
    try {
      await deps.write(deps.path, serializeApprovalsFile(next));
      return true;
    } catch (error) {
      log(`could not write ${deps.path}: ${error instanceof Error ? error.message : String(error)}; the approval is kept for this process only`);
      return false;
    }
  };

  return {
    entries: () => [...load().approvals, ...unwritten, ...session],
    reload: load,
    async remember(input) {
      if (input.scope === 'once') return;
      const createdAt = deps.now();
      const rows: DurableApproval[] = input.subjects.map((subject) => ({
        approvalId: input.approvalId,
        envId: input.envId,
        userId: input.userId,
        op: input.op,
        subject,
        scope: input.scope,
        createdAt,
        expiresAt: approvalExpiry(input.scope, createdAt),
      }));
      if (!isDurableScope(input.scope)) {
        session.push(...rows);
        return;
      }
      const loaded = load();
      const written = await writeDurable([...loaded.approvals, ...rows], loaded);
      if (!written) unwritten.push(...rows);
    },
    async revoke(approvalId) {
      let removed = 0;
      for (const set of [session, unwritten]) {
        for (let i = set.length - 1; i >= 0; i -= 1) {
          if (set[i]?.approvalId === approvalId) {
            set.splice(i, 1);
            removed += 1;
          }
        }
      }
      const loaded = load();
      const kept = loaded.approvals.filter((a) => a.approvalId !== approvalId);
      const fromFile = loaded.approvals.length - kept.length;
      if (fromFile > 0 && (await writeDurable(kept, loaded))) removed += fromFile;
      return removed;
    },
    async prune(now) {
      const loaded = load();
      const kept = loaded.approvals.filter((a) => a.expiresAt === null || a.expiresAt > now);
      const dropped = loaded.approvals.length - kept.length;
      if (dropped === 0) return 0;
      return (await writeDurable(kept, loaded)) ? dropped : 0;
    },
  };
}

/**
 * The production writer: directory 0700, a 0600 temp file beside the target,
 * then `rename` — so a reader never sees a half-written file and a crash
 * leaves the previous file intact.
 */
export async function writeApprovalsFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
