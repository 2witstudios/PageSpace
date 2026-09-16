/**
 * `findDuplicateResourceSlots` — a registry-load check (ADR 0004 §3.2, M8).
 * Each `{slot}` in a path template names one resource; a template that uses
 * the same name twice would have to pick which segment the resource is, so
 * it is reported as a defect to fix in the reviewed registry, never resolved
 * by position. Returns the offending templates; empty means sound. Pure.
 */
import type { OperationRegistry } from './canonical-request';
import { isPlaceholderSegment } from './is-placeholder-segment';

export function findDuplicateResourceSlots({ registry }: { readonly registry: OperationRegistry }): readonly string[] {
  return registry
    .filter((entry) => {
      const slots = entry.pathTemplate.split('/').filter(isPlaceholderSegment);
      return new Set(slots).size !== slots.length;
    })
    .map((entry) => entry.pathTemplate);
}
