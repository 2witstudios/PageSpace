import type { SecretMaterialByKind } from '../store/store-adapter';

export const DEFAULT_ACCESS_TTL_MS = 3_600_000;

export type RefreshedMaterialPlan =
  | { readonly ok: true; readonly rotated: boolean; readonly next: SecretMaterialByKind['oauth2'] }
  | { readonly ok: false; readonly reason: 'malformed' | 'token_type' | 'scope_widened' };

export function planRefreshedMaterial(_input: {
  readonly previous: SecretMaterialByKind['oauth2'];
  readonly response: unknown;
  readonly now: number;
}): RefreshedMaterialPlan {
  throw new Error('planRefreshedMaterial: not implemented (RED)');
}
