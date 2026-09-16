/**
 * `lookupOperation` — the ONLY source of an operation class (ADR 0004 §3.4
 * amendments M1, G1c R7, R17).
 *
 * The entry is chosen by what the SERVER knows — the account's
 * `providerSlug` (read from the row, bound inside `PlaneScope`), the
 * canonical origin, the channel, and the canonical method and path — never by
 * anything the tool layer says about the request. An account with no
 * provider, or an entry whose provider is not a string, matches nothing: a
 * generic origin never inherits a reviewed class, and a null-provider entry
 * can never match every origin.
 *
 * Several matching entries resolve to the MOST SPECIFIC (literal beats
 * `{slot}` beats `{slot+}`, compared from the left). Two equally specific
 * matches are a registry defect that `findOperationRegistryConflicts` reports
 * at load; if one still reaches a lookup it resolves to NEITHER (`null` →
 * `unknown`, which needs a concrete approval): an entry's position never
 * decides a class.
 *
 * The match's PATH slot values are returned under the restriction keys the
 * entry maps them to (a slot absent from `restrictionKeys` keeps its own
 * name), sorted by key, so a tool can never name its own resources (M8).
 *
 * Pure.
 */
import type { LookupOperation, OperationRegistryEntry } from './canonical-request';
import { bindTemplateSlots, type TemplateMatch } from './bind-template-slots';
import { compareSpecificity } from './compare-specificity';
import { sortResourcePairs } from './sort-resource-pairs';

export const lookupOperation: LookupOperation = ({ registry, providerSlug, origin, channel, method, path }) => {
  let best: { readonly entry: OperationRegistryEntry; readonly match: TemplateMatch } | null = null;
  let tied = false;
  for (const entry of registry) {
    if (typeof entry.providerSlug !== 'string' || entry.providerSlug !== providerSlug) continue;
    if (entry.origin !== origin || entry.channel !== channel || entry.method !== method) continue;
    const match = bindTemplateSlots({ pathTemplate: entry.pathTemplate, path });
    if (match === null) continue;
    const order = best === null ? 1 : compareSpecificity(match.specificity, best.match.specificity);
    if (order > 0) {
      best = { entry, match };
      tied = false;
    } else if (order === 0) {
      tied = true;
    }
  }
  if (best === null || tied) return null;
  const keys = best.entry.restrictionKeys;
  const resources = best.match.slots.map(([slot, value]) => [Object.hasOwn(keys, slot) ? keys[slot]! : slot, value] as const);
  return { entry: best.entry, resources: sortResourcePairs(resources) };
};
