/**
 * `findRegistryEntryDefects` — the per-entry registry-load check (ADR 0004
 * §3.2/§3.4, §5; G1c R6, R11, R17). A registry with any defect is not loaded.
 *
 * - `template_malformed`: the template does not start with `/`, or has an
 *   empty segment (including a trailing `/`) — it could never match a
 *   canonical path, so it would silently never apply.
 * - `multi_segment_slot_not_last`: `{slot+}` anywhere but the last segment.
 * - `duplicate_slot`: one slot name declared twice across path, body and
 *   derived slots.
 * - `audit_slot_undeclared`: `auditResourceSlots` names a slot the entry does
 *   not declare — the allowlist must describe this operation (R6).
 * - `restriction_key_for_undeclared_slot`: `restrictionKeys` maps a slot the
 *   entry does not declare.
 * - `restriction_key_shared`: two declared slots resolve to the same
 *   restriction key (by mapping, or a slot named like another slot's key).
 *   The audit projection filters by key, so an audited slot would carry a
 *   non-audited slot's values into the non-erasable chain (CodeRabbit #2660).
 * - `derived_resources_off_relay`: git-derived resources on an entry that is
 *   not a `relay-runner` `git-receive-pack` operation (R11) — the only request
 *   they can be derived from.
 *
 * Entries are reported in registry order, one defect per entry (the first
 * that applies, in the order above). Pure.
 */
import type { OperationRegistry } from './canonical-request';
import { declaredSlots } from './declared-slots';
import { parseTemplateSegment } from './parse-template-segment';

export type RegistryEntryDefect =
  | 'template_malformed'
  | 'multi_segment_slot_not_last'
  | 'duplicate_slot'
  | 'audit_slot_undeclared'
  | 'restriction_key_for_undeclared_slot'
  | 'restriction_key_shared'
  | 'derived_resources_off_relay';

export function findRegistryEntryDefects({
  registry,
}: {
  readonly registry: OperationRegistry;
}): readonly { readonly pathTemplate: string; readonly operationName: string; readonly defect: RegistryEntryDefect }[] {
  const defects: { readonly pathTemplate: string; readonly operationName: string; readonly defect: RegistryEntryDefect }[] = [];
  for (const entry of registry) {
    const defect = defectOf(entry);
    if (defect !== null) defects.push({ pathTemplate: entry.pathTemplate, operationName: entry.operation.name, defect });
  }
  return defects;
}

function defectOf(entry: OperationRegistry[number]): RegistryEntryDefect | null {
  const { pathTemplate } = entry;
  if (!pathTemplate.startsWith('/')) return 'template_malformed';
  const segments = pathTemplate.slice(1).split('/');
  if (segments.some((segment) => segment.length === 0)) return 'template_malformed';
  const kinds = segments.map(parseTemplateSegment);
  if (kinds.some((segment, index) => segment.kind === 'multi' && index !== kinds.length - 1)) return 'multi_segment_slot_not_last';
  const slots = declaredSlots(entry);
  const declared = new Set(slots);
  if (declared.size !== slots.length) return 'duplicate_slot';
  if (entry.auditResourceSlots.some((slot) => !declared.has(slot))) return 'audit_slot_undeclared';
  if (Object.keys(entry.restrictionKeys).some((slot) => !declared.has(slot))) return 'restriction_key_for_undeclared_slot';
  const keys = slots.map((slot) => (Object.prototype.hasOwnProperty.call(entry.restrictionKeys, slot) ? entry.restrictionKeys[slot]! : slot));
  if (new Set(keys).size !== keys.length) return 'restriction_key_shared';
  if (entry.derivedResources.length > 0 && (entry.channel !== 'relay-runner' || entry.method !== 'git-receive-pack')) return 'derived_resources_off_relay';
  return null;
}
