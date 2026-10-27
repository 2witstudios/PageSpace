/**
 * Structural completeness + identity gate (Phase 7 hardening, tightened for
 * 1.5.0): every operation defined anywhere under `operations/` must be
 * reachable through exactly one `client.<namespace>.<method>()` facade
 * method, AND each facade method must resolve to the registry operation of
 * the same name. The operation universe is discovered mechanically
 * (`import.meta.glob` + duck-typed `Operation` filter), never a
 * hand-maintained list — a new operations file or a new operation added to an
 * existing file is picked up automatically, so it can't go silently unwired
 * the way 9 whole namespaces previously did.
 *
 * The identity check exists because the completeness check alone only counts
 * operation NAMES: swapping two wirings (e.g. `calendar.get` ↔
 * `calendar.delete` — identical input schemas, same path, a data-destroying
 * GET→DELETE) used to pass the entire suite. Now every
 * `client.<ns>.<method>` must invoke the operation named `<ns>.<method>`,
 * with an explicit exception table for the deliberate short names.
 */
import { describe, expect, it } from 'vitest';
import { listWiredOperations } from '../client.js';
import { createRegistry } from '../registry/registry.js';
import { loadAllOperations } from './support/load-operations.js';

/**
 * The ONLY sanctioned facade-path ↔ operation-name divergences: shorter
 * facade verbs matching the already-shipped CLI surface. Anything else is a
 * mis-wiring. Adding an entry here is an API decision, not a fix.
 */
const FACADE_NAME_EXCEPTIONS: Readonly<Record<string, string>> = {
  'channels.send': 'channels.sendMessage',
  'channels.delete': 'channels.deleteMessage',
};

describe('PageSpaceClient facade — structural completeness', () => {
  it('wires every registry operation into exactly one client namespace method', () => {
    const allOps = loadAllOperations();
    // Guards the test itself: a duplicate operation name is a registry bug independent of wiring.
    const registry = createRegistry(allOps);
    expect(registry.all.length).toBeGreaterThan(0);

    const wiredCounts = new Map<string, number>();
    for (const wired of listWiredOperations()) {
      wiredCounts.set(wired.operation.name, (wiredCounts.get(wired.operation.name) ?? 0) + 1);
    }

    const unwired = registry.all.filter((op) => !wiredCounts.has(op.name)).map((op) => op.name);
    const duplicatelyWired = [...wiredCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);

    expect(unwired).toEqual([]);
    expect(duplicatelyWired).toEqual([]);
  });

  it('wires every client.<ns>.<method> to the registry operation of the same name (swap-proof identity)', () => {
    const mismatches = listWiredOperations()
      .map(({ namespace, method, operation }) => {
        const facadePath = `${namespace}.${method}`;
        const expectedName = FACADE_NAME_EXCEPTIONS[facadePath] ?? facadePath;
        return operation.name === expectedName
          ? null
          : `client.${facadePath} is wired to "${operation.name}", expected "${expectedName}"`;
      })
      .filter((entry): entry is string => entry !== null);

    expect(mismatches).toEqual([]);
  });

  it('keeps the exception table honest: every listed exception is actually wired that way', () => {
    const wiredByPath = new Map(listWiredOperations().map((w) => [`${w.namespace}.${w.method}`, w.operation.name]));
    const stale = Object.entries(FACADE_NAME_EXCEPTIONS)
      .filter(([facadePath, opName]) => wiredByPath.get(facadePath) !== opName)
      .map(([facadePath, opName]) => `${facadePath} -> ${opName}`);

    expect(stale).toEqual([]);
  });
});
