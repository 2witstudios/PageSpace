/**
 * The single-use ledger for `OwnerConsent.consentId` (ADR 0005 §2.2 `rebind`;
 * G1c E2) — I/O only, in the PLANE's own metadata store
 * (`infisical-dev/plane-metadata.sql`, `agent_account_consent_ledger`).
 *
 * Why the plane and not the main DB (G2 ruling 3, 2026-09-21): consumption is
 * what stops a consent from being applied twice, and the main-DB writer is
 * untrusted (R3). A ledger in `agent_account_grant_nonces` let that writer
 * delete the consumed row and replay the consent inside its max age. The
 * policyVersion CAS on the bindings row stays as the second line.
 *
 * Consumption is one `INSERT … ON CONFLICT DO NOTHING RETURNING`, so exactly
 * one caller across every plane replica and restart gets `consumed`. A store
 * that cannot answer is `unavailable` — never "assume fresh". Rows expire with
 * the consent's max age and are swept opportunistically; a consent older than
 * that is refused by `decideRebind` before it is ever presented here. What an
 * outcome MEANS for a rebind is `decideConsentConsumption`'s, not this file's.
 */
import type { Pool } from 'pg';
import type { ConsentId } from '../grant';
import type { ConsumeOutcome } from '../replay-store-repository';

/** `GRANT_MAX_CLOCK_SKEW_MS` × 2 — the margin `replay-store-repository.ts` sweeps grant nonces with. */
const SWEEP_MARGIN_MS = 60_000;

export type ConsentLedger = {
  /** Exactly one caller across all replicas ever gets `consumed` for a consent id. */
  readonly consume: (input: { readonly consentId: ConsentId; readonly expiresAt: number; readonly now: number }) => Promise<ConsumeOutcome>;
};

export function createConsentLedgerRepository({ pool }: { readonly pool: Pick<Pool, 'query'> }): ConsentLedger {
  return {
    async consume({ consentId, expiresAt, now }) {
      try {
        const result = await pool.query(
          `INSERT INTO agent_account_consent_ledger (consent_id, expires_at, consumed_at) VALUES ($1, $2, $3)
           ON CONFLICT (consent_id) DO NOTHING RETURNING 1`,
          [consentId, new Date(expiresAt), new Date(now)],
        );
        const outcome: ConsumeOutcome = result.rowCount === 1 ? 'consumed' : 'replayed';
        // Housekeeping after the decision; a sweep that fails changes nothing about this consumption.
        // Two clock-skew allowances past expiry, as the grant-nonce sweep: a replica whose clock runs
        // behind still refuses the consent as stale before its ledger row can be gone.
        await pool.query('DELETE FROM agent_account_consent_ledger WHERE expires_at < $1', [new Date(now - SWEEP_MARGIN_MS)]).catch(() => undefined);
        return outcome;
      } catch {
        return 'unavailable';
      }
    },
  };
}
