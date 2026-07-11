"use client";

import ComingSoonTab from './ComingSoonTab';

/**
 * PLACEHOLDER — the real Code tab (in-machine file browser + editor) is built
 * by a sibling follow-up PR (spec `kf9ap6oigt1xedi47wuym94a`). The `{ machineId }`
 * prop signature and file location are locked in here so that agent only fills
 * in the body (replacing the shared ComingSoonTab placeholder).
 */
export default function CodeTab({ machineId }: { machineId: string }) {
  return <ComingSoonTab machineId={machineId} label="Code" />;
}
