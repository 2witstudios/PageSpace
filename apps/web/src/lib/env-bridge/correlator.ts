/**
 * Request/reply correlator — the id-correlated pending map, per-request
 * deadline and cancel-all core that BOTH bridges sit on: the MCP desktop
 * bridge (`lib/mcp/mcp-bridge.ts`, 30 s default preserved there) and the env
 * bridge (deadlines from `resolveTimeout`, never a fixed default — an agent
 * command routinely runs for minutes and a PTY is open for as long as the
 * terminal is).
 *
 * What it guarantees:
 * - A reply for an id that is not pending — late, duplicate, forged — resolves
 *   NOTHING. It is dropped and reported through `onDropped`, so the socket
 *   handler can log it and move on (invariant 6: unknown frames are dropped,
 *   never guessed).
 * - Every request belongs to a `group` (a userId, an envId) so a lost socket
 *   can cancel exactly its own in-flight requests with a typed error, and no
 *   one else's.
 * - The clock is injected. Production gets `setTimeout`; tests use fake timers
 *   (the default reads the global lazily, so `vi.useFakeTimers()` works) or a
 *   recording stub.
 *
 * Pure-ish: no I/O of its own. The only side effect it performs is calling
 * the `send` thunk the caller hands it, inside the same turn the request is
 * registered, so a reply can never arrive before its id is pending.
 */
import { grantOpForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { resolveTimeout } from '@pagespace/lib/env-bridge/resolve-timeout';

export type CorrelationFailureKind =
  /** No reply within the request's deadline. */
  | 'timeout'
  /** The `send` thunk threw; nothing was registered. */
  | 'send_failed'
  /** The connection carrying this request went away. */
  | 'disconnected'
  /** A reply arrived but its machine signature did not verify (invariant 7). */
  | 'unverified_result'
  /** An id already pending was opened again; the original is untouched. */
  | 'duplicate_id'
  /** Cancelled by the owner for a stated reason. */
  | 'cancelled';

export class CorrelationError extends Error {
  constructor(
    readonly kind: CorrelationFailureKind,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CorrelationError';
  }
}

export interface CorrelatorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Reads the globals at CALL time so fake timers installed after construction still apply. */
const globalTimers: CorrelatorTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface OpenRequestInput {
  /** The correlation id the reply will carry. */
  readonly id: string;
  /** Whose request this is (a userId, an envId) — the unit `cancelGroup` acts on. */
  readonly group: string;
  /** Deadline in ms, or `'unbounded'` for a channel whose liveness is the heartbeat's job (PTY). */
  readonly timeoutMs: number | 'unbounded';
  /** Puts the request on the wire. Invoked once, synchronously, after the id is pending. */
  readonly send: () => void;
}

interface Pending<T> {
  readonly group: string;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: unknown | null;
}

export class RequestCorrelator<T> {
  private readonly pending = new Map<string, Pending<T>>();
  private readonly timers: CorrelatorTimers;
  private readonly onDropped: (id: string) => void;

  constructor(options: { timers?: CorrelatorTimers; onDropped?: (id: string) => void } = {}) {
    this.timers = options.timers ?? globalTimers;
    this.onDropped = options.onDropped ?? (() => {});
  }

  /** Register `id`, arm its deadline, put it on the wire. Rejects with a typed `CorrelationError` on every failure path. */
  open(input: OpenRequestInput): Promise<T> {
    if (this.pending.has(input.id)) {
      return Promise.reject(new CorrelationError('duplicate_id', `Request id already pending: ${input.id}`, { id: input.id }));
    }
    return new Promise<T>((resolve, reject) => {
      const timer =
        input.timeoutMs === 'unbounded'
          ? null
          : this.timers.setTimeout(() => {
              this.pending.delete(input.id);
              reject(new CorrelationError('timeout', `Request timed out after ${input.timeoutMs}ms`, { id: input.id, timeoutMs: input.timeoutMs }));
            }, input.timeoutMs);
      this.pending.set(input.id, { group: input.group, resolve, reject, timer });
      try {
        input.send();
      } catch (error) {
        this.take(input.id);
        reject(new CorrelationError('send_failed', `Failed to send request: ${error instanceof Error ? error.message : String(error)}`, { id: input.id }));
      }
    });
  }

  /** @returns false when nothing was pending under `id` — the reply is dropped and reported, nothing resolves. */
  resolve(id: string, value: T): boolean {
    const entry = this.take(id);
    if (!entry) {
      this.onDropped(id);
      return false;
    }
    entry.resolve(value);
    return true;
  }

  /** @returns false when nothing was pending under `id` — dropped and reported. */
  reject(id: string, error: Error): boolean {
    const entry = this.take(id);
    if (!entry) {
      this.onDropped(id);
      return false;
    }
    entry.reject(error);
    return true;
  }

  /** Reject every request in `group` with `error`. @returns how many were cancelled. */
  cancelGroup(group: string, error: Error): number {
    let count = 0;
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.group !== group) continue;
      this.take(id);
      entry.reject(error);
      count += 1;
    }
    return count;
  }

  /** Reject everything pending. @returns how many were cancelled. */
  cancelAll(error: Error): number {
    let count = 0;
    for (const [id, entry] of [...this.pending.entries()]) {
      this.take(id);
      entry.reject(error);
      count += 1;
    }
    return count;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** The group a pending id belongs to — the env that OWNS the request; undefined when nothing is pending under `id`. */
  groupOf(id: string): string | undefined {
    return this.pending.get(id)?.group;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingCountForGroup(group: string): number {
    let count = 0;
    for (const entry of this.pending.values()) if (entry.group === group) count += 1;
    return count;
  }

  /** Remove `id` and disarm its deadline. */
  private take(id: string): Pending<T> | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    return entry;
  }
}

/**
 * The correlator deadline for a grant frame — ALWAYS from `resolveTimeout`,
 * so an exec with `timeoutMs: 120_000` waits its full two minutes plus
 * transport margin and a PTY open is `'unbounded'`. There is no other source
 * of this number for the env bridge.
 */
export function grantCorrelatorTimeoutMs(frame: GrantFrame): number | 'unbounded' {
  const timeoutMs = frame.type === 'grant_exec' ? frame.timeoutMs : undefined;
  return resolveTimeout({ op: grantOpForFrame(frame), timeoutMs }).correlatorTimeoutMs;
}
