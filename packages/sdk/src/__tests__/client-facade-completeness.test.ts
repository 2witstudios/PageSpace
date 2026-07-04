/**
 * Structural completeness gate (Phase 7 hardening): every operation defined
 * anywhere under `operations/` must be reachable through exactly one
 * `client.<namespace>.<method>()` facade method. The operation universe is
 * discovered mechanically (directory scan + duck-typed `Operation` filter),
 * never a hand-maintained list — a new operations file or a new operation
 * added to an existing file is picked up automatically, so it can't go
 * silently unwired the way the `calendar` namespace previously did.
 */
import { describe, expect, it } from 'vitest';
import type { AuthProvider } from '../auth/provider.js';
import { PageSpaceClient } from '../client.js';
import type { Operation } from '../registry/define.js';
import { createRegistry } from '../registry/registry.js';

/**
 * `import.meta.glob` is Vite's statically-analyzable enumeration of every
 * sibling module under `operations/` (one level deep — `__tests__/*.test.ts`
 * lives in a subdirectory the pattern doesn't reach). Eager so the modules
 * are already evaluated; no runtime `fs`/dynamic-import-by-string needed.
 */
const OPERATION_MODULES = import.meta.glob('../operations/*.ts', { eager: true }) as Record<string, Record<string, unknown>>;

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

function fakeAuth(): AuthProvider {
  return {
    getAccessToken: async () => 'token',
    invalidate: () => {},
  };
}

describe('PageSpaceClient facade — structural completeness', () => {
  it('exposes every registry operation through exactly one client namespace method', () => {
    const allOps = loadAllOperations();
    // Guards the test itself: a duplicate operation name is a registry bug independent of wiring.
    const registry = createRegistry(allOps);
    expect(registry.all.length).toBeGreaterThan(0);

    const client = new PageSpaceClient({
      baseUrl: 'https://pagespace.ai',
      auth: fakeAuth(),
      skipVersionCheck: true,
    });
    const clientAsRecord = client as unknown as Record<string, unknown>;

    const unwired: string[] = [];
    for (const op of registry.all) {
      const dotIndex = op.name.indexOf('.');
      const namespace = dotIndex === -1 ? op.name : op.name.slice(0, dotIndex);
      const method = dotIndex === -1 ? '' : op.name.slice(dotIndex + 1);

      const namespaceObj = clientAsRecord[namespace];
      const fn =
        namespaceObj && typeof namespaceObj === 'object' ? (namespaceObj as Record<string, unknown>)[method] : undefined;

      if (typeof fn !== 'function') {
        unwired.push(op.name);
      }
    }

    expect(unwired).toEqual([]);
  });
});
