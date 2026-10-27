/**
 * `decideSandboxBinding` — the ABA guard for relay operations (ADR 0006 §3,
 * §7; ADR 0004 F9).
 *
 * The sprite name, instance id and generation are all compared. The
 * instance id catches a sprite deleted and recreated under the same
 * name; the generation catches a checkpoint restore that kept the id. Both
 * are compared for EQUALITY with what the provisioner observes now — an older
 * snapshot presented as current is as wrong as a newer one. An observation
 * that could not be made is a refusal, never a pass: the issuance-time id is
 * not trusted on its own (ADR 0006 F5).
 *
 * The structural rule lives here too so it has one definition: a relay
 * grant without a sandbox is meaningless, and a sandbox on any other channel
 * is a grant for the wrong executor — both `malformed` (ADR 0006 F1).
 *
 * Pure.
 */
import type { PresenterChannel, SandboxBinding } from './grant';

export type SandboxBindingVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'malformed' | 'generation_mismatch' | 'binding_unavailable' };

export type DecideSandboxBinding = (input: {
  readonly grant: SandboxBinding | null;
  readonly observed: SandboxBinding | null;
  readonly aud: PresenterChannel;
}) => SandboxBindingVerdict;

export const decideSandboxBinding: DecideSandboxBinding = ({ grant, observed, aud }) => {
  const relay = aud === 'relay-runner';
  if (relay !== (grant !== null)) return { ok: false, reason: 'malformed' };
  if (grant === null) return { ok: true };
  if (observed === null) return { ok: false, reason: 'binding_unavailable' };
  // The sprite NAME too: two sprites can share id and generation values.
  if (grant.spriteName !== observed.spriteName) return { ok: false, reason: 'generation_mismatch' };
  if (grant.instanceId !== observed.instanceId) return { ok: false, reason: 'generation_mismatch' };
  if (grant.generation !== observed.generation) return { ok: false, reason: 'generation_mismatch' };
  return { ok: true };
};
