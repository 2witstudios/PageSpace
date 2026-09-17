/**
 * `decideCas` — our compare-and-swap, as data (ADR 0005 §2.3, §9
 * `DecideStoreWrite`). Infisical has read-side versions but no write-side
 * CAS, so the adapter does version-check-then-write under a per-secret
 * Postgres advisory lock and hands this function what it observed; this
 * function never touches Infisical or Postgres itself.
 *
 * `write_unverified` is a refusal to REPORT success, not a rollback: the
 * material may have landed but the post-write read disagreed (an
 * overlapping writer that slipped past the lock, or bindings that were not
 * echoed back correctly) — reconciliation is a later gate's job, not this
 * function's.
 */
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import { canonicalJson } from '../canonical-json';
import type { DecideStoreWrite } from './store-adapter';

export const decideCas: DecideStoreWrite = ({ expectedVersion, observedBefore, observedAfter, bindingsAfter, bindingsWritten }) => {
  if (observedBefore !== expectedVersion) return { outcome: 'version_conflict' };

  const base = (observedBefore ?? 0) as CredentialVersion;
  const expectedAfter = (base + 1) as CredentialVersion;
  if (observedAfter !== expectedAfter) return { outcome: 'write_unverified' };

  if (bindingsAfter === null || canonicalJson(bindingsAfter) !== canonicalJson(bindingsWritten)) {
    return { outcome: 'write_unverified' };
  }

  return { outcome: 'commit', version: observedAfter };
};
