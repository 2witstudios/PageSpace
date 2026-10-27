/**
 * `decideOrphanAdoption` — a first put that finds its key already in
 * Infisical (ADR 0005 §2.3; G1c E1). A first put has no metadata row to carry
 * a pending write, so material from an earlier first put whose commit failed
 * is an orphan: present in Infisical, invisible to resolve. The put adopts it
 * only when the orphan is exactly the write this put is attempting (a retry of
 * the same put); any other bytes are erased before the put proceeds, so
 * material nobody committed is never silently promoted. Pure.
 */
import { secureCompare } from '../../auth/secure-compare';
import type { DecideOrphanAdoption } from './store-adapter';

export const decideOrphanAdoption: DecideOrphanAdoption = ({ attempted, observed }) =>
  secureCompare(observed.digest, attempted) ? { outcome: 'adopt', version: observed.version } : { outcome: 'erase' };
