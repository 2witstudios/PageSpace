/**
 * `lookupOperation` — the ONLY source of an operation class (ADR 0004 §3.4
 * amendment; G1a review M1).
 *
 * The entry is chosen by what the SERVER knows — the account's
 * `providerSlug` (read from the row), the channel, and the canonical method
 * and path — never by anything the tool layer says about the request. No
 * match is `null`, which the caller turns into `unknown`/`generic_request`.
 *
 * More than one match is a registry defect that
 * `findOperationRegistryConflicts` reports at load. If one still reaches a
 * lookup it resolves to NEITHER (`null` → `unknown`, which needs a concrete
 * approval): picking the first by order would let an entry's position decide
 * a class.
 *
 * Pure.
 */
import type { LookupOperation } from './canonical-request';
import { templateMatchesPath } from './template-matches-path';

export const lookupOperation: LookupOperation = ({ registry, providerSlug, channel, method, path }) => {
  const matches = registry.filter(
    (entry) =>
      entry.providerSlug === providerSlug &&
      entry.channel === channel &&
      entry.method === method &&
      templateMatchesPath({ pathTemplate: entry.pathTemplate, path }),
  );
  return matches.length === 1 ? matches[0]! : null;
};
