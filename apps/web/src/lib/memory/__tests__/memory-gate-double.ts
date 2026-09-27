import type { MemoryGated, MemoryGateRefusal } from '../memory-credit-gate';

/**
 * Test double for `withMemoryCreditHold`, for the service tests that mock the
 * database: admits by default, refuses with `refuseWith` when set, and records
 * each hold the service asked for. The real gate is covered by
 * memory-credit-gate.test.ts and, against Postgres, by the cron's
 * credit-gate.integration.test.ts.
 */
export const memoryGate = {
  refuseWith: null as MemoryGateRefusal | null,
  holds: [] as Array<{ userId: string; modelCalls: number }>,
  reset(): void {
    this.refuseWith = null;
    this.holds = [];
  },
};

export async function fakeWithMemoryCreditHold<T>(
  userId: string,
  modelCalls: number,
  run: () => Promise<T>,
): Promise<MemoryGated<T>> {
  memoryGate.holds.push({ userId, modelCalls });
  if (memoryGate.refuseWith) return { ran: false, reason: memoryGate.refuseWith };
  return { ran: true, value: await run() };
}
