/**
 * How a `substrate: 'local'` env maps to a provision/attach verdict.
 *
 * The provisioners today assume every env is a Sprite. This planner is the
 * one place that decision is made for a local env, and it returns a TYPED
 * verdict rather than a sandbox: `attach_local` when the machine is live,
 * `not_connected` when it is not (never a Sprite provision, never a queue),
 * `revoked` when the row says so even if a socket is still open (the row
 * wins over the socket), and `not_local` for anything that is not a local
 * env — including an unknown substrate value — so the caller keeps its
 * existing Sprite path for those and never attaches to something it does
 * not understand.
 *
 * Pure: no db, no host, no clock.
 */

export interface ProvisionEnv {
  readonly id: string;
  readonly substrate: string;
  readonly revokedAt: number | string | Date | null;
}

export interface PlanLocalProvisionInput {
  readonly env: ProvisionEnv;
  readonly connected: boolean;
}

export type LocalProvisionPlan =
  | { readonly kind: 'attach_local'; readonly envId: string }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'not_local' };

/** @returns the typed plan for this env; `not_local` means "not mine — keep the Sprite path". */
export function planLocalProvision(input: PlanLocalProvisionInput): LocalProvisionPlan {
  if (input.env.substrate !== 'local') return { kind: 'not_local' };
  if (input.env.revokedAt !== null) return { kind: 'revoked' };
  if (!input.connected) return { kind: 'not_connected' };
  return { kind: 'attach_local', envId: input.env.id };
}
