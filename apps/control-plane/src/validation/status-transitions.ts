export type TenantStatus =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'destroying'
  | 'destroyed'
  | 'failed'

const VALID_TRANSITIONS: Record<TenantStatus, Set<TenantStatus>> = {
  provisioning: new Set(['active', 'failed']),
  active: new Set(['suspended', 'destroying']),
  suspended: new Set(['active', 'destroying']),
  failed: new Set(['destroying']),
  destroying: new Set(['destroyed']),
  destroyed: new Set(),
}

export const canTransition = (from: TenantStatus, to: TenantStatus): boolean =>
  VALID_TRANSITIONS[from]?.has(to) ?? false
