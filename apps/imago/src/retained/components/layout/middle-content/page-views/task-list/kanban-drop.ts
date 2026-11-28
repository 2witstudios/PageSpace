/**
 * The status a card dropped on `overId` moves to on the Board. `overId` is either
 * another card (its column's status) or a column itself (its status). Null when
 * the drop lands on nothing the board knows.
 */
export const kanbanDropStatus = (
  tasksByStatus: Readonly<Record<string, readonly { readonly id: string }[]>>,
  statusOrder: readonly string[],
  overId: string,
): string | null => {
  for (const status of statusOrder) {
    if (tasksByStatus[status]?.some((task) => task.id === overId)) return status;
  }
  return statusOrder.includes(overId) ? overId : null;
};
