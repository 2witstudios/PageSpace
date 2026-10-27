/**
 * Shared operation-discovery helper for the SDK's structural guard tests
 * (`client-facade-completeness.test.ts`, `input-schema-strict-guard.test.ts`).
 * Both need the full universe of `Operation`-shaped exports across
 * `operations/*.ts`, discovered mechanically rather than via a hand-maintained
 * list, so a new operations file or a new operation is picked up automatically.
 */
import type { Operation } from '../../registry/define.js';

/**
 * `import.meta.glob` (Vite/vitest) isn't in the package's `ImportMeta` type —
 * this package has no `vite/client` types reference (it's a library, not a
 * Vite app) — so the single method this needs is declared locally rather
 * than pulling in vite's own (much wider) ambient types.
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
const OPERATION_MODULES = import.meta.glob('../../operations/*.ts', { eager: true });

export function isOperation(value: unknown): value is Operation {
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
export function loadAllOperations(): Operation[] {
  const ops: Operation[] = [];
  for (const mod of Object.values(OPERATION_MODULES)) {
    for (const exported of Object.values(mod)) {
      if (isOperation(exported)) ops.push(exported);
    }
  }
  return ops;
}
