/**
 * `deriveTenantId` — the tenant domain a store reference lives under (ADR 0005 §3.1).
 *
 * Derived, never chosen: `user:<userId>` for a user-owned account, `drive:<driveId>`
 * for an agent-page-owned account (D-16). Pure and idempotent — the same owner
 * always derives the same id, which is what lets `mapTenantProject` and
 * `selectIdentity` key an Infisical project and a machine identity off it.
 */
import type { AccountOwnerRef, TenantId } from '@pagespace/db/schema/agent-accounts';

export type DeriveTenantId = (input: { readonly owner: AccountOwnerRef }) => TenantId;

export const deriveTenantId: DeriveTenantId = ({ owner }) =>
  (owner.kind === 'user' ? `user:${owner.userId}` : `drive:${owner.driveId}`) as TenantId;
