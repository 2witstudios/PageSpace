/**
 * SIEM chain-verification preflight — pure logic.
 *
 * Takes an anchor hash (the logHash of the last successfully delivered entry
 * for this source) plus a batch of entries for a single source, and decides
 * whether the batch's hash chain is intact. Returns a result — never throws
 * for domain errors. Throwing is reserved for programmer errors, and this
 * function's only such error would be a malformed strategy callback, which
 * we let propagate.
 *
 * Chain-verification for dual-source SIEM delivery: each source has its own
 * chain, and the SIEM worker groups the merged batch by source before calling
 * this function once per source. Do NOT pass a cross-source batch — the
 * chain links will not line up.
 */

export interface ChainVerifiableEntry {
  readonly id: string;
  readonly logHash: string | null;
  readonly previousLogHash: string | null;
}

export type VerificationBreakReason = 'hash_mismatch' | 'chain_break' | 'missing_hash';

export type VerificationResult =
  | { valid: true; verifiedCount: number }
  | {
      valid: false;
      /** entries that passed before the break */
      verifiedCount: number;
      /** index of the first failing entry within the source-batch */
      breakAtIndex: number;
      breakReason: VerificationBreakReason;
      /** what the broken entry's logHash (or link) should have been */
      expectedHash: string | null;
      /** what the broken entry's logHash (or link) actually was */
      actualHash: string | null;
    };

export interface VerifyChainForSourceParams<T extends ChainVerifiableEntry> {
  /**
   * The logHash/eventHash of the last successfully delivered entry for this
   * source. Null ONLY when the source's cursor has just been initialized
   * (CURSOR_INIT_SENTINEL) — in that case entry 0 is trusted as-is because
   * the write-side's chain seed (activity_logs) or 'genesis' literal
   * (security_audit_log) is not recoverable from AuditLogEntry alone. Once
   * a real row has been delivered, the caller passes its hash here.
   */
  anchorHash: string | null;
  /**
   * Source-scoped, timestamp-ascending batch. MUST NOT include entries from
   * any other source — mixing sources breaks the chain-link check.
   */
  entries: readonly T[];
  /**
   * Re-compute the expected logHash for an entry given the previous entry's
   * hash (or the anchor). Strategies live in siem-chain-hashers.ts because
   * the two sources use different hash formulas.
   */
  recomputeHash: (entry: T, previousHash: string) => string;
}

const ok = (verifiedCount: number): VerificationResult => ({
  valid: true,
  verifiedCount,
});

const fail = (
  verifiedCount: number,
  breakAtIndex: number,
  breakReason: VerificationBreakReason,
  expectedHash: string | null,
  actualHash: string | null
): VerificationResult => ({
  valid: false,
  verifiedCount,
  breakAtIndex,
  breakReason,
  expectedHash,
  actualHash,
});

export function verifyChainForSource<T extends ChainVerifiableEntry>(
  params: VerifyChainForSourceParams<T>
): VerificationResult {
  const { anchorHash, entries, recomputeHash } = params;

  if (entries.length === 0) {
    return ok(0);
  }

  // Fresh-init case: we have no anchor, and the hasher cannot recompute
  // entry 0's logHash without the write-side's chain-start value (random
  // chainSeed for activity_logs, the literal 'genesis' for security_audit_log,
  // neither of which is carried on AuditLogEntry). Entry 0 is implicitly
  // trusted; its logHash becomes the anchor for entry 1 onward. This matches
  // the contract the worker guarantees when it calls us — if the cursor is
  // still at CURSOR_INIT_SENTINEL the worker is supposed to skip us entirely,
  // but we handle the null anchor defensively so misuse doesn't explode.
  let startIndex = 0;
  let previousHash: string;
  if (anchorHash === null) {
    // Entry 0 is implicitly trusted, but it still must HAVE a logHash —
    // otherwise entry 1 has nothing to chain to and a single-entry batch
    // would falsely validate against an empty-string anchor.
    if (entries[0].logHash === null) {
      return fail(0, 0, 'missing_hash', null, null);
    }
    previousHash = entries[0].logHash;
    startIndex = 1;
  } else {
    previousHash = anchorHash;
  }

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];

    // Missing-hash check applies universally to verified entries. A null
    // logHash means the write-side never computed one (legacy data? bug?)
    // and we cannot recompute; treat as tamper for safety. Do not call
    // recomputeHash here — a strategy that throws on malformed data would
    // break the function's non-throw domain contract. Report null for
    // expectedHash; the stored hash is null by definition.
    if (entry.logHash === null) {
      return fail(i, i, 'missing_hash', null, null);
    }

    // Chain-link check: does the entry point at the expected previous hash?
    // For entry 0 that's the anchor; for entry N > 0 that's entries[N-1].logHash.
    if (entry.previousLogHash !== previousHash) {
      return fail(
        i,
        i,
        'chain_break',
        previousHash,
        entry.previousLogHash
      );
    }

    // Tamper check: does the recomputed hash match what's stored?
    const expected = recomputeHash(entry, previousHash);
    if (expected !== entry.logHash) {
      return fail(i, i, 'hash_mismatch', expected, entry.logHash);
    }

    previousHash = entry.logHash;
  }

  return ok(entries.length);
}
