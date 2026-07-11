"use client";

interface SettingsTabProps {
  /** The Machine page's own id (= pageId). */
  machineId: string;
}

/**
 * PLACEHOLDER — the real Settings tab (machine config, env, resource controls)
 * is built by a sibling follow-up PR (spec `o2yv9twc782guwfrr2pawcif`). The
 * `{ machineId }` prop signature and file location are locked in here so that
 * agent only fills in the body.
 */
export default function SettingsTab({ machineId }: SettingsTabProps) {
  return (
    <div
      data-machine-id={machineId}
      className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      Settings tab — coming soon
    </div>
  );
}
