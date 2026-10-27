import { useDeploymentCapability } from '@/hooks/useDeploymentCapability';

/** Whether app hosting is turned on for this deployment — see `useDeploymentCapability` for the contract. */
export function useAppHostingCapability(): boolean | undefined {
  return useDeploymentCapability('/api/app-hosting/capability');
}
