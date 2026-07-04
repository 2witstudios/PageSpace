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
import type { Operation } from '../registry/define.js';
import { createRegistry } from '../registry/registry.js';

/**
 * `import.meta.glob` (Vite/vitest) isn't in the package's `ImportMeta` type —
 * this package has no `vite/client` types reference (it's a library, not a
 * Vite app) — so the single method this test needs is declared locally
 * rather than pulling in vite's own (much wider) ambient types.
 */
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/**
 * Vite's statically-analyzable enumeration of every sibling module under
 * `operations/` (one level deep — `__tests__/*.test.ts` lives in a
 * subdirectory the pattern doesn't reach). Eager so the modules are already
 * evaluated; no runtime `fs`/dynamic-import-by-string needed.
 */
const OPERATION_MODULES = import.meta.glob('../operations/*.ts', { eager: true });

function isOperation(value: unknown): value is Operation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const inputSchema = candidate.inputSchema as { safeParse?: unknown } | undefined;
  const outputSchema = candidate.outputSchema as { safeParse?: unknown } | undefined;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.method === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.description === 'string' &&
    typeof inputSchema?.safeParse === 'function' &&
    typeof outputSchema?.safeParse === 'function'
  );
}

/** Every `Operation`-shaped export across every module in `operations/` — the full registry universe. */
function loadAllOperations(): Operation[] {
  const ops: Operation[] = [];
  for (const mod of Object.values(OPERATION_MODULES)) {
    for (const exported of Object.values(mod)) {
      if (isOperation(exported)) ops.push(exported);
    }
  }
  return ops;
}

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
