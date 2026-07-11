"use client";

import ComingSoonTab from './ComingSoonTab';

/**
 * PLACEHOLDER — the real Diff tab (per-branch working-tree diff viewer) is
 * built by a sibling follow-up PR (spec `lmnkz43dpczplbz4d2xuinob`). The
 * `{ machineId }` prop signature and file location are locked in here so that
 * agent only fills in the body (replacing the shared ComingSoonTab placeholder).
 */
export default function DiffTab({ machineId }: { machineId: string }) {
  return <ComingSoonTab machineId={machineId} label="Diff" />;
}
