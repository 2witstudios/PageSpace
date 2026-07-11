"use client";

import ComingSoonTab from './ComingSoonTab';

/**
 * PLACEHOLDER — the real Settings tab (machine config, env, resource controls)
 * is built by a sibling follow-up PR (spec `o2yv9twc782guwfrr2pawcif`). The
 * `{ machineId }` prop signature and file location are locked in here so that
 * agent only fills in the body (replacing the shared ComingSoonTab placeholder).
 */
export default function SettingsTab({ machineId }: { machineId: string }) {
  return <ComingSoonTab machineId={machineId} label="Settings" />;
}
