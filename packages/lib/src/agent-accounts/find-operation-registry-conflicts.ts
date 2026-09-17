/**
 * `findOperationRegistryConflicts` — the registry-load check (ADR 0004 §3.4
 * amendment). Two entries conflict when some request could match both: same
 * provider, channel and method, same segment count, and every segment pair
 * either equal or at least one a placeholder. A conflict is a defect to fix
 * in the reviewed registry, never something resolved by entry order.
 *
 * Returns the conflicting `[pathTemplate, pathTemplate]` pairs; empty means
 * the registry is sound. Pure.
 */
import type { OperationRegistry, OperationRegistryEntry } from './canonical-request';
import { isPlaceholderSegment } from './is-placeholder-segment';

function overlaps(a: OperationRegistryEntry, b: OperationRegistryEntry): boolean {
  if (a.providerSlug !== b.providerSlug || a.channel !== b.channel || a.method !== b.method) return false;
  const left = a.pathTemplate.split('/');
  const right = b.pathTemplate.split('/');
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index]!;
    return segment === other || isPlaceholderSegment(segment) || isPlaceholderSegment(other);
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
