/**
 * `decideAccountCreation` — what a human asked to store, as a verdict, before
 * anything touches the database or the credential plane (L2·G2).
 *
 * Order: the kind first — this slice implements `api_key` only, and every
 * other member of the frozen union (D-20 keeps `session` and `password` in it)
 * is refused with a typed reason, so a later gate adds behaviour, not a
 * variant. Then the name, the pinned origins (the one origin rule,
 * `normalizeOrigin`; each canonical origin once, sorted), the acknowledgment
 * (`decideAcknowledgment`) and the key's placement.
 *
 * Placement may name `authorization` — setting it is the executor's job, and
 * the one place a caller-supplied value never reaches. It may not name a
 * header the transport owns (`host`, framing, hop-by-hop, proxy and forwarding
 * headers) or one the canonical request projects (`accept`, `content-type`,
 * `content-length`): the executor would either fight the transport or send a
 * value the approved digest never covered. A query placement is one
 * unreserved-character name, so it cannot smuggle a second parameter. Pure.
 */
import type { AccountAcknowledgment, AccountKind } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from './canonical-request';
import type { SecretMaterialByKind } from './store/store-adapter';
import { decideAcknowledgment, type LoginOwnership } from './decide-acknowledgment';
import { normalizeOrigin, type NormalizeOriginVerdict } from './normalize-origin';

export type KeyPlacement = SecretMaterialByKind['api_key']['placement'];

export type AccountDraft = {
  readonly kind: 'api_key';
  readonly name: string;
  readonly allowedOrigins: readonly CanonicalOrigin[];
  readonly acknowledgment: AccountAcknowledgment;
  readonly placement: KeyPlacement;
};

export type AccountCreationRefusal =
  | { readonly ok: false; readonly reason: 'kind_not_supported' | 'name_invalid' | 'origins_empty' | 'acknowledgment_required' | 'placement_invalid' }
  | { readonly ok: false; readonly reason: 'origin_invalid'; readonly index: number; readonly rule: Extract<NormalizeOriginVerdict, { readonly ok: false }>['reason'] };

export type AccountCreationVerdict = { readonly ok: true; readonly draft: AccountDraft } | AccountCreationRefusal;

export const MAX_ACCOUNT_NAME_LENGTH = 100;

const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QUERY_NAME_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const TRANSPORT_OR_PROJECTED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'cookie',
  'connection',
  'upgrade',
  'transfer-encoding',
  'te',
  'trailer',
  'keep-alive',
  'expect',
  'forwarded',
  'via',
  'accept',
  'content-type',
  'content-length',
]);
const RESERVED_HEADER_PREFIXES: readonly string[] = ['proxy-', 'x-forwarded-'];

function placementOf(placement: KeyPlacement): KeyPlacement | null {
  if (placement === null || typeof placement !== 'object' || typeof placement.name !== 'string') return null;
  if (placement.in === 'query') return QUERY_NAME_RE.test(placement.name) ? { in: 'query', name: placement.name } : null;
  if (placement.in !== 'header' || !HEADER_TOKEN_RE.test(placement.name)) return null;
  const name = placement.name.toLowerCase();
  if (TRANSPORT_OR_PROJECTED_HEADERS.has(name) || RESERVED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  return { in: 'header', name };
}

export function decideAccountCreation(input: {
  readonly kind: AccountKind;
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly ownership: LoginOwnership;
  readonly acknowledged: boolean;
  readonly placement: KeyPlacement;
}): AccountCreationVerdict {
  if (input.kind !== 'api_key') return { ok: false, reason: 'kind_not_supported' };

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > MAX_ACCOUNT_NAME_LENGTH) return { ok: false, reason: 'name_invalid' };

  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length === 0) return { ok: false, reason: 'origins_empty' };
  const origins = new Set<CanonicalOrigin>();
  for (let index = 0; index < input.allowedOrigins.length; index += 1) {
    const verdict = normalizeOrigin({ raw: input.allowedOrigins[index]! });
    if (!verdict.ok) return { ok: false, reason: 'origin_invalid', index, rule: verdict.reason };
    origins.add(verdict.origin);
  }

  const acknowledgment = decideAcknowledgment({ kind: input.kind, ownership: input.ownership, acknowledged: input.acknowledged });
  if (!acknowledgment.ok) return { ok: false, reason: 'acknowledgment_required' };

  const placement = placementOf(input.placement);
  if (placement === null) return { ok: false, reason: 'placement_invalid' };

  return {
    ok: true,
    draft: { kind: 'api_key', name, allowedOrigins: [...origins].sort(), acknowledgment: acknowledgment.acknowledgment, placement },
  };
}
