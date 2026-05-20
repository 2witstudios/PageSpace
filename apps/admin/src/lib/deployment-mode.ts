export function isOnPrem(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'onprem';
}

export function isTenantMode(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'tenant';
}

export function isCloud(): boolean {
  return !isOnPrem() && !isTenantMode();
}
