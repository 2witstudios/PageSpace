import { useDeploymentCapability } from '@/hooks/useDeploymentCapability';

/**
 * Whether dev-server preview is turned on for this deployment
 * (`DEV_PREVIEW_ENABLED` AND a configured `DEV_PREVIEW_APEX`, server-derived).
 * Callers render NOTHING for anything but `true` — see `useDeploymentCapability`.
 */
export function useDevPreviewCapability(): boolean | undefined {
  return useDeploymentCapability('/api/dev-preview/capability');
}
