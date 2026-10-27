export interface ReorderEntry {
  id: string;
  position: number;
}

export interface ReorderPlan {
  orderedIds: string[];
  positionById: Map<string, number>;
}

/**
 * Reduce a caller-submitted reorder request into the plan every locked-batch
 * writer executes against: dedup ids (last write wins) and lock/update them
 * in ascending-id order. Ascending-id order is the shared contract that
 * prevents deadlocks between concurrent reorders — see
 * `lockDriveRolesInOrder` in drive-role-service.ts for why a consistent
 * order matters.
 */
export function computeReorderPlan(entries: ReorderEntry[]): ReorderPlan {
  const positionById = new Map<string, number>();
  for (const entry of entries) {
    positionById.set(entry.id, entry.position);
  }

  const orderedIds = Array.from(positionById.keys()).sort();

  return { orderedIds, positionById };
}
