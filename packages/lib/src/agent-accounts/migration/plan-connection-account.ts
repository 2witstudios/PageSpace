import type { AuthMethod } from '../../integrations/types';
import type { CanonicalOrigin } from '../canonical-request';
import type { SecretMaterialByKind } from '../store/store-adapter';

export type ConnectionAccountPlan =
  | {
      readonly ok: true;
      readonly owner: { readonly kind: 'user'; readonly userId: string };
      readonly kind: 'api_key';
      readonly material: SecretMaterialByKind['api_key'];
      readonly allowedOrigins: readonly CanonicalOrigin[];
      readonly providerSlug: string;
    }
  | { readonly ok: false; readonly reason: 'drive_scoped' | 'base_url_override' | 'invalid_origin' | 'no_credential' | 'unsupported_auth' | 'needs_refresh_worker' | 'value_invalid' };

export function planConnectionAccount(_input: {
  readonly connection: { readonly userId: string | null; readonly driveId: string | null; readonly baseUrlOverride: string | null };
  readonly provider: { readonly slug: string; readonly baseUrl: string; readonly authMethod: AuthMethod };
  readonly credentials: Readonly<Record<string, string>>;
}): ConnectionAccountPlan {
  throw new Error('planConnectionAccount: not implemented (RED)');
}
