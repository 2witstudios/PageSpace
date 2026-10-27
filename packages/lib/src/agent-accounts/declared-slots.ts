/**
 * `declaredSlots` — every resource slot name an entry declares, in
 * declaration order with repeats kept: its path-template placeholders, its
 * body slots (G1c R5) and its derived resources (G1c R11). Pure.
 */
import type { OperationRegistryEntry } from './canonical-request';
import { parseTemplateSegment } from './parse-template-segment';

export function declaredSlots(entry: OperationRegistryEntry): readonly string[] {
  const pathSlots = entry.pathTemplate
    .split('/')
    .map(parseTemplateSegment)
    .flatMap((segment) => (segment.kind === 'literal' ? [] : [segment.slot]));
  return [...pathSlots, ...entry.bodySlots.map(({ slot }) => slot), ...entry.derivedResources.map(({ slot }) => slot)];
}
