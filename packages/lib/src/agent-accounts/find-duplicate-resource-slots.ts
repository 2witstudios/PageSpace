/**
 * `findDuplicateResourceSlots` — a registry-load check (ADR 0004 §3.2, M8;
 * G1c R5/R11). Each slot names one resource; an entry that declares the same
 * name twice — twice in its path, or once in its path and once as a body or
 * derived slot — would have to pick which value the resource is, so it is
 * reported as a defect to fix in the reviewed registry, never resolved by
 * position. Returns the offending templates; empty means sound. Pure.
 */
import type { OperationRegistry } from './canonical-request';
import { declaredSlots } from './declared-slots';

export function findDuplicateResourceSlots({ registry }: { readonly registry: OperationRegistry }): readonly string[] {
  return registry
    .filter((entry) => {
      const slots = declaredSlots(entry);
      return new Set(slots).size !== slots.length;
    })
    .map((entry) => entry.pathTemplate);
}
