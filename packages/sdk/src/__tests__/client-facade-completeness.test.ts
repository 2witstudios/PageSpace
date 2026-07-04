/**
 * Structural completeness gate (Phase 7 hardening): every operation defined
 * anywhere under `operations/` must be reachable through exactly one
 * `client.<namespace>.<method>()` facade method. The operation universe is
 * discovered mechanically (`import.meta.glob` + duck-typed `Operation`
 * filter), never a hand-maintained list — a new operations file or a new
 * operation added to an existing file is picked up automatically, so it
 * can't go silently unwired the way 9 whole namespaces previously did.
 * Wiring is checked via `listWiredOperations()` (client.ts) rather than by
 * guessing a namespace/method key from the operation's own name, since the
 * facade doesn't guarantee that convention (e.g. `channels.send` wires
 * `channels.sendMessage`).
 */
import { describe, expect, it } from 'vitest';
import { listWiredOperations } from '../client.js';
import { createRegistry } from '../registry/registry.js';
import { loadAllOperations } from './support/load-operations.js';

describe('PageSpaceClient facade — structural completeness', () => {
  it('wires every registry operation into exactly one client namespace method', () => {
    const allOps = loadAllOperations();
    // Guards the test itself: a duplicate operation name is a registry bug independent of wiring.
    const registry = createRegistry(allOps);
    expect(registry.all.length).toBeGreaterThan(0);

    // Membership by the operation's own name, not by guessing a namespace/method
    // key from it — the facade is free to expose an operation under a shorter
    // method name than its registry name (e.g. `channels.send` for the
    // `channels.sendMessage` operation, to match an already-shipped CLI verb).
    const wiredCounts = new Map<string, number>();
    for (const op of listWiredOperations()) {
      wiredCounts.set(op.name, (wiredCounts.get(op.name) ?? 0) + 1);
    }

    const unwired = registry.all.filter((op) => !wiredCounts.has(op.name)).map((op) => op.name);
    const duplicatelyWired = [...wiredCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);

    expect(unwired).toEqual([]);
    expect(duplicatelyWired).toEqual([]);
  });
});
