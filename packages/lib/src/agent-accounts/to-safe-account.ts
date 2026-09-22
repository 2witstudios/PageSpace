/**
 * `toSafeAccount` — the ONLY shape an agent account leaves the server in
 * (L2·G2; the `SafeConnection` allowlist of `api/user/integrations/route.ts`).
 *
 * An explicit allowlist, never a spread of the row: the row has no secret
 * column today, but a spread would forward whatever a join, a future column
 * or a careless caller attached. The tenant, owner ids, policy, restrictions
 * and versions are withheld too — `view` shows that an account exists, its
 * kind, name, origins, status, acknowledgment and last use (ADR 0004 §4.1),
 * nothing a caller could use to address the plane. Pure.
 */
import type { AccountAcknowledgment, AccountKind, AccountOwnerKind, AccountStatus, AgentAccountRecord, UpstreamRevocation } from '@pagespace/db/schema/agent-accounts';

export type SafeAccount = {
  readonly id: string;
  readonly kind: AccountKind;
  readonly name: string;
  readonly ownerKind: AccountOwnerKind;
  readonly providerSlug: string | null;
  readonly allowedOrigins: readonly string[];
  /** Shown in the account list: which acknowledgment the human gave when the credential was stored. */
  readonly acknowledgment: AccountAcknowledgment;
  readonly status: AccountStatus;
  /** Whether the provider itself was asked to revoke the key; null until a delete attempted it. */
  readonly upstreamRevocation: UpstreamRevocation | null;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  /** False until the credential plane committed the material (credentialVersion 0): listed, but not usable yet. */
  readonly ready: boolean;
};

export function toSafeAccount({ row }: { readonly row: AgentAccountRecord }): SafeAccount {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ownerKind: row.ownerKind,
    providerSlug: row.providerSlug,
    allowedOrigins: [...row.allowedOrigins],
    acknowledgment: row.acknowledgment,
    status: row.status,
    upstreamRevocation: row.upstreamRevocation,
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    revokedAt: row.revokedAt?.getTime() ?? null,
    ready: row.credentialVersion > 0,
  };
}
