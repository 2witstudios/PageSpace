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
import type { AccountApprovalPolicy } from './approval';
import type { UserId } from './grant';
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
  /** null = every request asks a human; otherwise the bounded generic-request policy the human chose. */
  readonly approvalPolicy: AccountApprovalPolicy | null;
};

export type AccountCreationRefusal =
  | { readonly ok: false; readonly reason: 'kind_not_supported' | 'name_invalid' | 'origins_empty' | 'acknowledgment_required' | 'placement_invalid' | 'key_invalid' }
  | { readonly ok: false; readonly reason: 'origin_invalid'; readonly index: number; readonly rule: Extract<NormalizeOriginVerdict, { readonly ok: false }>['reason'] };

export type AccountCreationVerdict = { readonly ok: true; readonly draft: AccountDraft } | AccountCreationRefusal;

export const MAX_ACCOUNT_NAME_LENGTH = 100;
const MAX_KEY_LENGTH = 8_192;
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/**
 * "Allow requests to these origins without asking each time" — ADR 0004 §3.4
 * lets a human accept generic requests to an origin as a bounded capability.
 * Bounded: only `unknown/generic_request` by exact name, only the pinned
 * origins, a use and byte ceiling, and the trigger still asks for every
 * irreversible or privileged operation.
 */
const GENERIC_REQUEST_LIMITS = { maxUsesPerHour: 60, maxBytesOut: 10 * 1024 * 1024, maxConcurrent: 4 } as const;

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
  /** The key itself — validated here, never part of the draft. */
  readonly apiKey: string;
  /** Exactly `true` = the human ticked "allow without asking each time". */
  readonly allowGenericRequests: boolean;
  /** The human creating the account; recorded as the policy's approver. */
  readonly approver: UserId;
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

  if (typeof input.apiKey !== 'string' || input.apiKey.length === 0 || input.apiKey.length > MAX_KEY_LENGTH || CONTROL_CHAR_RE.test(input.apiKey)) return { ok: false, reason: 'key_invalid' };

  const allowedOrigins = [...origins].sort();
  const approvalPolicy: AccountApprovalPolicy | null =
    input.allowGenericRequests === true
      ? { scope: { origins: allowedOrigins, operations: [{ class: 'unknown', name: 'generic_request' }], resources: [] }, trigger: 'irreversible_only', duration: null, limits: { ...GENERIC_REQUEST_LIMITS }, approver: input.approver }
      : null;

  return {
    ok: true,
    draft: { kind: 'api_key', name, allowedOrigins, acknowledgment: acknowledgment.acknowledgment, placement, approvalPolicy },
  };
}
