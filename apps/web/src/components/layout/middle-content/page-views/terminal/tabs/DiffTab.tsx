"use client";

interface DiffTabProps {
  /** The Machine page's own id (= pageId). */
  machineId: string;
}

/**
 * PLACEHOLDER — the real Diff tab (per-branch working-tree diff viewer) is
 * built by a sibling follow-up PR (spec `lmnkz43dpczplbz4d2xuinob`). The
 * `{ machineId }` prop signature and file location are locked in here so that
 * agent only fills in the body.
 */
export default function DiffTab({ machineId }: DiffTabProps) {
  return (
    <div
      data-machine-id={machineId}
      className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      Diff tab — coming soon
    </div>
  );
}
