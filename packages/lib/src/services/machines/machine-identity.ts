/**
 * Machine identity (pure).
 *
 * A "Machine" is a Sprite with a persistent filesystem, addressed one of two
 * ways (mirrors `MachineRef` in apps/web/src/lib/repositories/
 * page-agent-repository.ts, kept dependency-free here since packages/lib must
 * not import from apps/web):
 *
 *  - a user's own dedicated machine — identity is the owner's userId;
 *  - an existing Terminal page's shared machine — identity is the page id.
 *
 * `deriveMachineKey` collapses either into one opaque string used to key
 * machine sessions and projects. It is NOT a security boundary by itself
 * (unlike `deriveSessionKey`'s HMAC) — the machine key is only ever looked up
 * after the caller has already been authorized for the identity it names
 * (owner match, or page-permission check), so an unguessable digest buys
 * nothing here.
 */

export type MachineIdentity =
  | { kind: 'own'; ownerId: string }
  | { kind: 'existing'; terminalId: string };

export function deriveMachineKey(machine: MachineIdentity): string {
  return machine.kind === 'own' ? `own:${machine.ownerId}` : `existing:${machine.terminalId}`;
}
