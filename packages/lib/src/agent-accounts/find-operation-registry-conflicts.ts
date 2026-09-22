/**
 * `findOperationRegistryConflicts` — the registry-load check (ADR 0004 §3.4
 * amendment; G1c R17). Two entries conflict when some request could match
 * both AND neither is more specific: same provider, origin, channel and
 * method, the same segment-kind shape (literal / `{slot}` / `{slot+}` at every
 * position), and equal literals wherever both are literal. A literal and a
 * slot at one position never conflict — the literal wins at lookup. A
 * conflict is a defect to fix in the reviewed registry, never something
 * resolved by entry order.
 *
 * Returns the conflicting `[pathTemplate, pathTemplate]` pairs; empty means
 * the registry is sound. Pure.
 */
import type { OperationRegistry, OperationRegistryEntry } from './canonical-request';
import { parseTemplateSegment } from './parse-template-segment';

function overlaps(a: OperationRegistryEntry, b: OperationRegistryEntry): boolean {
  if (a.providerSlug !== b.providerSlug || a.origin !== b.origin || a.channel !== b.channel || a.method !== b.method) return false;
  const left = a.pathTemplate.split('/').map(parseTemplateSegment);
  const right = b.pathTemplate.split('/').map(parseTemplateSegment);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index]!;
    if (segment.kind !== other.kind) return false;
    return segment.kind !== 'literal' || other.kind !== 'literal' || segment.text === other.text;
  });
}

export function findOperationRegistryConflicts({
  registry,
}: {
  readonly registry: OperationRegistry;
}): readonly (readonly [string, string])[] {
  const conflicts: (readonly [string, string])[] = [];
  for (let i = 0; i < registry.length; i += 1) {
    for (let j = i + 1; j < registry.length; j += 1) {
      if (overlaps(registry[i]!, registry[j]!)) conflicts.push([registry[i]!.pathTemplate, registry[j]!.pathTemplate]);
    }
  }
  return conflicts;
}
