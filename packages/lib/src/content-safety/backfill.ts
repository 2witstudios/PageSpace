/**
 * Backfill and rescan — the walk over content that was already public before
 * the publish gate existed, and the periodic rescan of what it has seen.
 *
 * One walker (`BACKFILL_ID`) lists the publish bucket's `assets/` and then the
 * uploads bucket's `avatars/`, a page at a time, and gates each object with the
 * publish gate: a fresh verdict is skipped without a read or a vendor call, so
 * only objects with no verdict or an expired one (a `clean` past its TTL, an
 * `error`) are scanned. When a pass finishes, the next starts once
 * `repassAfterMs` has passed.
 *
 * - **Resumable.** The last key finished is persisted (`startAfter`); a crash
 *   or a failed item resumes there on the next tick.
 * - **Rate-limited.** At most `itemsPerTick` objects per tick.
 * - **Idempotent.** Re-gating an object with a fresh verdict changes nothing.
 * - **One at a time.** A lease on the cursor row keeps two ticks apart.
 *
 * This file is the pure orchestration: listing, gating and the actions on a
 * finding come in through `BackfillDeps` (apps/web/src/lib/content-safety/backfill-service.ts).
 */

import type { ContentScanBackfillCounts, ContentScanBackfillPhase } from '@pagespace/db/schema/content-safety';
import type { GateFinding, StoredVerdict } from './publish-gate';
import { isVerdictFresh } from './scan-policy';

export const BACKFILL_ID = 'public-surfaces';

export type BackfillWalkPhase = Exclude<ContentScanBackfillPhase, 'done'>;
export const BACKFILL_PHASES: readonly BackfillWalkPhase[] = ['assets', 'avatars'];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BackfillConfig {
  /** Objects gated per tick, at most. Each can be one vendor call. */
  itemsPerTick: number;
  /** How long after a pass finishes the next one starts. */
  repassAfterMs: number;
  /** How long a tick holds the cursor. Longer than a tick can run. */
  leaseMs: number;
}

export const DEFAULT_BACKFILL_ITEMS_PER_TICK = 25;
export const MAX_BACKFILL_ITEMS_PER_TICK = 500;
export const DEFAULT_BACKFILL_REPASS_HOURS = 24;
export const BACKFILL_LEASE_MS = 30 * 60 * 1000;

type Env = Record<string, string | undefined>;

function positiveInteger(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** Pure: the backfill's configuration for an environment. */
export function resolveBackfillConfig(env: Env): BackfillConfig {
  return {
    itemsPerTick: positiveInteger(env.CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK, DEFAULT_BACKFILL_ITEMS_PER_TICK, MAX_BACKFILL_ITEMS_PER_TICK),
    repassAfterMs: positiveInteger(env.CONTENT_SCAN_BACKFILL_REPASS_HOURS, DEFAULT_BACKFILL_REPASS_HOURS, 24 * 365) * 60 * 60 * 1000,
    leaseMs: BACKFILL_LEASE_MS,
  };
}

// ---------------------------------------------------------------------------
// What a key is
// ---------------------------------------------------------------------------

export type BackfillTarget =
  /** `assets/<hash>`: the public copy itself. `assets/cache/<hash>/…`: a derived copy, gated as its original. */
  | { kind: 'asset'; key: string; contentHash: string; derived: boolean }
  /** `avatars/<userId>/avatar.<ext>`: a profile picture. Not content-addressed: its hash is known once read. */
  | { kind: 'avatar'; key: string; userId: string; extension: string };

const ASSET_KEY = /^assets\/([0-9a-f]{64})$/;
const DERIVED_ASSET_KEY = /^assets\/cache\/([0-9a-f]{64})\/[^/]+$/;
const AVATAR_KEY = /^avatars\/([A-Za-z0-9_-]{1,64})\/avatar\.(png|jpe?g|gif|webp)$/i;

/** Pure: the object a listed key is, or null for a key the walk leaves alone. */
export function parseBackfillKey(phase: BackfillWalkPhase, key: string): BackfillTarget | null {
  if (phase === 'assets') {
    const asset = ASSET_KEY.exec(key);
    if (asset) return { kind: 'asset', key, contentHash: asset[1], derived: false };
    const derived = DERIVED_ASSET_KEY.exec(key);
    if (derived) return { kind: 'asset', key, contentHash: derived[1], derived: true };
    return null;
  }
  const avatar = AVATAR_KEY.exec(key);
  return avatar ? { kind: 'avatar', key, userId: avatar[1], extension: avatar[2].toLowerCase() } : null;
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

export interface BackfillCursor {
  phase: ContentScanBackfillPhase;
  startAfter: string | null;
  pass: number;
  counts: ContentScanBackfillCounts;
  lastPassCounts: ContentScanBackfillCounts | null;
  passStartedAt: Date;
  lastCompletedAt: Date | null;
  /**
   * The lease this run holds (set by `claim`). A save is refused unless the row still carries it, so a run
   * whose lease expired and was taken over cannot overwrite the new holder's cursor.
   */
  lease?: Date | null;
}

export function emptyBackfillCounts(): ContentScanBackfillCounts {
  return { listed: 0, skippedFresh: 0, scanned: 0, clean: 0, flagged: 0, hashMatch: 0, errors: 0, unscanned: 0, unverified: 0, blocked: 0, removed: 0, ignored: 0 };
}

/** What gating one object did. */
export interface BackfillItemOutcome {
  finding: GateFinding;
  /** The vendor was called. */
  scanned: boolean;
  /** The public copy (or the avatar) was taken off the web. */
  removed: boolean;
}

/** Pure: the counts after one object. */
export function countItem(counts: ContentScanBackfillCounts, outcome: BackfillItemOutcome | null): ContentScanBackfillCounts {
  const next = { ...counts, listed: counts.listed + 1 };
  if (!outcome) return { ...next, ignored: next.ignored + 1 };
  if (outcome.scanned) next.scanned += 1;
  else if (!['off', 'unavailable', 'blocked'].includes(outcome.finding)) next.skippedFresh += 1;
  if (outcome.removed) next.removed += 1;
  switch (outcome.finding) {
    case 'clean':
      next.clean += 1;
      break;
    case 'flagged':
      next.flagged += 1;
      break;
    case 'hash_match':
      next.hashMatch += 1;
      break;
    case 'error':
    case 'unavailable':
      next.errors += 1;
      break;
    case 'unscanned':
      next.unscanned += 1;
      break;
    case 'unverified':
      next.unverified += 1;
      break;
    case 'blocked':
      next.blocked += 1;
      break;
    case 'off':
      break;
  }
  return next;
}

/** Pure: a cursor at the start of a new pass. */
export function startPass(cursor: BackfillCursor, now: Date): BackfillCursor {
  return { ...cursor, phase: 'assets', startAfter: null, pass: cursor.pass + 1, counts: emptyBackfillCounts(), passStartedAt: now };
}

/** Pure: the cursor after a phase's listing ran out. */
export function finishPhase(cursor: BackfillCursor, now: Date): BackfillCursor {
  const index = BACKFILL_PHASES.indexOf(cursor.phase as BackfillWalkPhase);
  const next = BACKFILL_PHASES[index + 1];
  if (next) return { ...cursor, phase: next, startAfter: null };
  return { ...cursor, phase: 'done', startAfter: null, lastCompletedAt: now, lastPassCounts: cursor.counts };
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

export interface ListedObject {
  key: string;
  size: number;
}

export interface BackfillDeps {
  /** Take the lease on the cursor (creating it at the start of pass 1). Null when another run holds it. */
  claim(now: Date, leaseMs: number): Promise<BackfillCursor | null>;
  /** Persist the cursor; `release` gives the lease up. Throws when the run no longer holds the lease. */
  save(cursor: BackfillCursor, options: { release: boolean }): Promise<void>;
  /** Keys under the phase's prefix, after `startAfter`, in key order. */
  list(phase: BackfillWalkPhase, startAfter: string | null, maxKeys: number): Promise<{ objects: ListedObject[]; truncated: boolean }>;
  /**
   * Gate one object and act on what was found. Null when the object is gone (deleted since it was listed).
   * Throws when it could not be checked (e.g. the blocklist is unreachable): the walk stops before it.
   */
  process(target: BackfillTarget, object: ListedObject): Promise<BackfillItemOutcome | null>;
  now(): Date;
}

export type BackfillTickResult =
  | { state: 'busy' }
  | { state: 'idle'; pass: number; nextPassAt: Date }
  | {
      state: 'walked';
      pass: number;
      phase: ContentScanBackfillPhase;
      processed: number;
      scanned: number;
      /** The pass finished in this tick. */
      completed: boolean;
      /** Set when an object could not be checked: the cursor stops before it and the next tick retries it. */
      failedKey?: string;
    };

/**
 * Walk up to `itemsPerTick` objects from where the last tick stopped. The
 * cursor is saved after every page, and when an object throws the walk stops
 * before it, so nothing is skipped and nothing finished is redone.
 */
export async function runBackfillTick(deps: BackfillDeps, config: BackfillConfig): Promise<BackfillTickResult> {
  const claimed = await deps.claim(deps.now(), config.leaseMs);
  if (!claimed) return { state: 'busy' };

  let cursor = claimed;
  let released = false;
  const release = async () => {
    released = true;
    await deps.save(cursor, { release: true });
  };

  try {
    if (cursor.phase === 'done') {
      const last = cursor.lastCompletedAt?.getTime() ?? 0;
      const nextPassAt = new Date(last + config.repassAfterMs);
      if (deps.now().getTime() < nextPassAt.getTime()) {
        await release();
        return { state: 'idle', pass: cursor.pass, nextPassAt };
      }
      cursor = startPass(cursor, deps.now());
    }

    let processed = 0;
    let scanned = 0;
    let completed = false;
    // A tick stops well inside its lease, so the lease cannot expire under it and be taken over.
    const deadline = deps.now().getTime() + config.leaseMs / 2;
    while (processed < config.itemsPerTick && cursor.phase !== 'done' && deps.now().getTime() < deadline) {
      const phase = cursor.phase;
      const page = await deps.list(phase, cursor.startAfter, config.itemsPerTick - processed);
      for (const object of page.objects) {
        if (deps.now().getTime() >= deadline) break;
        const target = parseBackfillKey(phase, object.key);
        let outcome: BackfillItemOutcome | null = null;
        if (target) {
          try {
            outcome = await deps.process(target, object);
          } catch {
            await release();
            return { state: 'walked', pass: cursor.pass, phase: cursor.phase, processed, scanned, completed: false, failedKey: object.key };
          }
        }
        cursor = { ...cursor, startAfter: object.key, counts: countItem(cursor.counts, outcome) };
        processed += 1;
        if (outcome?.scanned) scanned += 1;
      }
      const handledPage = page.objects.length === 0 || cursor.startAfter === page.objects[page.objects.length - 1].key;
      // The listing ran out: every key in the phase has been handled.
      if (!page.truncated && handledPage) {
        cursor = finishPhase(cursor, deps.now());
        if (cursor.phase === 'done') completed = true;
      }
      await deps.save(cursor, { release: false });
      // A truncated listing that returned nothing would otherwise be asked for again forever.
      if (page.truncated && page.objects.length === 0) break;
    }

    await release();
    return { state: 'walked', pass: cursor.pass, phase: cursor.phase, processed, scanned, completed };
  } finally {
    if (!released) await deps.save(cursor, { release: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Dry run: how much work, and how many vendor calls, a pass would take
// ---------------------------------------------------------------------------

export interface DryRunDeps {
  list(phase: BackfillWalkPhase, startAfter: string | null, maxKeys: number): Promise<{ objects: ListedObject[]; truncated: boolean }>;
  /** The stored verdicts of these hashes. */
  findVerdicts(contentHashes: string[]): Promise<Map<string, StoredVerdict>>;
  now(): Date;
}

export interface DryRunCounts {
  assets: { objects: number; hashes: number; fresh: number; needScan: number; bytesToRead: number; ignored: number };
  avatars: { objects: number; bytesToRead: number; ignored: number };
}

export interface DryRunResult {
  counts: DryRunCounts;
  /**
   * The most vendor calls a full pass from here would make: every asset hash with no fresh verdict, plus every
   * avatar (an avatar's hash is only known once it is read). Types the vendor can't read (PDFs, fonts, …) are
   * classified without a call, so the real number is lower.
   */
  estimatedVendorCalls: number;
  /** Null when the whole walk was counted; else where to continue (pass it back as `phase` and `startAfter`). */
  next: { phase: BackfillWalkPhase; startAfter: string } | null;
}

const DRY_RUN_PAGE = 1000;

/** Whether a stored verdict would let the gate skip the scan, under `ttlMs`. Mirrors the gate's own short-circuits. */
export function verdictSkipsScan(stored: StoredVerdict | undefined, ttlMs: number, now: Date): boolean {
  if (!stored || !isVerdictFresh(stored.scannedAt, ttlMs, now)) return false;
  if (stored.verdict === 'clean' || stored.verdict === 'unverified') return true;
  if (stored.verdict === 'flagged') return stored.outcome === 'classifier_flag';
  return stored.verdict === 'unscanned' && stored.unscannedAllowed !== undefined;
}

/**
 * Count, without reading an object's bytes or calling the vendor. Stateless:
 * it never moves the real cursor. Stops after `maxPages` listing pages and
 * says where to continue.
 */
export async function runBackfillDryRun(
  deps: DryRunDeps,
  options: { verdictTtlMs: number; maxPages: number; from?: { phase: BackfillWalkPhase; startAfter: string | null } },
): Promise<DryRunResult> {
  const counts: DryRunCounts = {
    assets: { objects: 0, hashes: 0, fresh: 0, needScan: 0, bytesToRead: 0, ignored: 0 },
    avatars: { objects: 0, bytesToRead: 0, ignored: 0 },
  };
  const seen = new Set<string>();
  const now = deps.now();
  let phaseIndex = Math.max(0, BACKFILL_PHASES.indexOf(options.from?.phase ?? 'assets'));
  let startAfter = options.from?.startAfter ?? null;
  let pages = 0;

  while (phaseIndex < BACKFILL_PHASES.length) {
    const phase = BACKFILL_PHASES[phaseIndex];
    if (pages >= options.maxPages) {
      return { counts, estimatedVendorCalls: counts.assets.needScan + counts.avatars.objects, next: { phase, startAfter: startAfter ?? '' } };
    }
    const page = await deps.list(phase, startAfter, DRY_RUN_PAGE);
    pages += 1;

    if (phase === 'assets') {
      const fresh: Array<{ hash: string; size: number }> = [];
      for (const object of page.objects) {
        const target = parseBackfillKey(phase, object.key);
        if (!target || target.kind !== 'asset') {
          counts.assets.ignored += 1;
          continue;
        }
        counts.assets.objects += 1;
        if (seen.has(target.contentHash)) continue;
        seen.add(target.contentHash);
        fresh.push({ hash: target.contentHash, size: object.size });
      }
      const verdicts = fresh.length > 0 ? await deps.findVerdicts(fresh.map((entry) => entry.hash)) : new Map<string, StoredVerdict>();
      for (const { hash, size } of fresh) {
        counts.assets.hashes += 1;
        if (verdictSkipsScan(verdicts.get(hash), options.verdictTtlMs, now)) {
          counts.assets.fresh += 1;
        } else {
          counts.assets.needScan += 1;
          counts.assets.bytesToRead += size;
        }
      }
    } else {
      for (const object of page.objects) {
        if (!parseBackfillKey(phase, object.key)) {
          counts.avatars.ignored += 1;
          continue;
        }
        counts.avatars.objects += 1;
        counts.avatars.bytesToRead += object.size;
      }
    }

    const last = page.objects[page.objects.length - 1];
    if (page.truncated && last) {
      startAfter = last.key;
    } else {
      phaseIndex += 1;
      startAfter = null;
    }
  }
  return { counts, estimatedVendorCalls: counts.assets.needScan + counts.avatars.objects, next: null };
}
