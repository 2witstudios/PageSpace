"use client";

interface CodeTabProps {
  /** The Machine page's own id (= pageId). */
  machineId: string;
}

/**
 * PLACEHOLDER — the real Code tab (in-machine file browser + editor) is built
 * by a sibling follow-up PR (spec `kf9ap6oigt1xedi47wuym94a`). The `{ machineId }`
 * prop signature and file location are locked in here so that agent only fills
 * in the body.
 */
export default function CodeTab({ machineId }: CodeTabProps) {
  return (
    <div
      data-machine-id={machineId}
      className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      Code tab — coming soon
    </div>
  );
}
