/**
 * Registry container (Phase 2 task 5). Immutable data + pure lookups —
 * `createRegistry` is the only place that can throw (duplicate names at
 * construction); `getOperation`/`hasOperation`/`listOperations` are total,
 * side-effect-free reads over the frozen result.
 */
import type { Operation } from './define.js';

export interface OperationRegistry {
  readonly byName: ReadonlyMap<string, Operation>;
  readonly all: readonly Operation[];
}

/** Rejects duplicate operation names at construction; never mutated afterward. */
export function createRegistry(ops: readonly Operation[]): OperationRegistry {
  const byName = new Map<string, Operation>();
  for (const op of ops) {
    if (byName.has(op.name)) {
      throw new Error(`Duplicate operation name in registry: "${op.name}"`);
    }
    byName.set(op.name, op);
  }
  return Object.freeze({ byName, all: Object.freeze([...ops]) });
}

export function getOperation(registry: OperationRegistry, name: string): Operation | undefined {
  return registry.byName.get(name);
}

export function hasOperation(registry: OperationRegistry, name: string): boolean {
  return registry.byName.has(name);
}

/** Phase 6 walks this to emit MCP tool definitions. */
export function listOperations(registry: OperationRegistry): readonly Operation[] {
  return registry.all;
}
