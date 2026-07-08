// Client-safe deployment-mode check (server code imports @pagespace/lib/deployment-mode).
export function isOnPrem(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'onprem';
}
