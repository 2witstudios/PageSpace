import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Unit tests for the @gridland/web `process.nextTick` build-time patch loader.
 *
 * The loader is pure string transformation (no I/O), so it can be exercised
 * directly with synthetic source strings. These lock in the three behaviors
 * that must hold for the fix to be safe:
 *   1. it injects a working `nextTick` onto gridland's `process` object,
 *   2. it preserves the upstream `NODE_ENV` value (no hardcoding), and
 *   3. it is a no-op when the upstream shape changes (so an upstream fix
 *      doesn't double-define `nextTick`).
 */

// The loader is CJS (webpack loaders run in Node). Require it by absolute path
// so vitest's src-scoped include picks this test up while still loading the
// loader from its real location under webpack-loaders/.
const loaderPath = path.resolve(__dirname, '../../../webpack-loaders/gridland-process-nexttick.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loader = require(loaderPath);
const fakeContext = { cacheable: () => {} };

function run(source: string): string {
  return loader.call(fakeContext, source);
}

describe('gridland-process-nexttick loader', () => {
  it('given gridland\'s process object, should inject a nextTick function', () => {
    const source = 'var process = { env: { NODE_ENV: "production" } }';
    const result = run(source);

    expect(result).toContain('nextTick');
    expect(result).toContain('function');
    // The deferral primitives the implementation relies on.
    expect(result).toContain('queueMicrotask');
    expect(result).toContain('setTimeout');
  });

  it('given the process object, should produce balanced braces (valid JS)', () => {
    const source = 'var process = { env: { NODE_ENV: "production" } }';
    const result = run(source);

    const opens = (result.match(/\{/g) ?? []).length;
    const closes = (result.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('given a non-production NODE_ENV, should preserve the original value', () => {
    const source = 'var process = { env: { NODE_ENV: "development" } }';
    const result = run(source);

    expect(result).toContain('NODE_ENV: "development"');
    expect(result).not.toContain('NODE_ENV: "production"');
  });

  it('given the production NODE_ENV, should preserve production exactly', () => {
    const source = 'var process = { env: { NODE_ENV: "production" } }';
    const result = run(source);

    expect(result).toContain('NODE_ENV: "production"');
  });

  it('given a process object that already defines nextTick, should be a no-op', () => {
    // If upstream fixes the bug (adds nextTick), the literal no longer matches
    // the env-only shape, so the loader must return the source unchanged.
    const source = 'var process = { env: { NODE_ENV: "production" }, nextTick: function() {} }';
    const result = run(source);

    expect(result).toBe(source);
  });

  it('given source that does not match the gridland process shape, should be a no-op', () => {
    const source = 'var somethingElse = { env: { NODE_ENV: "production" } }';
    const result = run(source);

    expect(result).toBe(source);
  });

  it('given a full gridland-like source, should patch only the process literal', () => {
    const source = [
      'var process = { env: { NODE_ENV: "production" } }',
      'function doWork() { process.nextTick(function() { render(); }); }',
    ].join('\n');

    const result = run(source);

    // The process object gained nextTick...
    expect(result).toMatch(/nextTick:\s*function/);
    // ...and the existing call site is untouched.
    expect(result).toContain('process.nextTick(function() { render(); })');
  });
});
