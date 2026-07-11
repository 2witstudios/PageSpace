"use client";

/** Shared placeholder body for the not-yet-built Machine tabs. Each tab keeps
 * its own `{ machineId }` entry file (CodeTab/DiffTab/SettingsTab) so the
 * parallel follow-up PRs can swap in their real implementation independently;
 * this just holds the common "coming soon" chrome they share until then. */
export default function ComingSoonTab({ machineId, label }: { machineId: string; label: string }) {
  return (
    <div
      data-machine-id={machineId}
      className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      {label} tab — coming soon
    </div>
  );
}
