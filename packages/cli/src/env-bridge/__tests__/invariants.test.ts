/**
 * Structural invariants of the daemon, pinned by reading the source (epic
 * invariant 1 "never listens"; Agent Contract "child_process in exactly one
 * file" and "no re-implemented checks — decisions come from
 * @pagespace/lib/env-bridge").
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const HERE = join(import.meta.dirname, '..');
const COMMANDS = join(HERE, '..', 'commands', 'env');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__') out.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

const daemonFiles = [...sourceFiles(HERE), ...sourceFiles(COMMANDS)];

/** Escape EVERY RegExp metacharacter (backslash included) so a literal can be embedded in a pattern. */
const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (path: string) => readFileSync(path, 'utf8');
const name = (path: string) => relative(join(HERE, '..'), path);

/** Every security decision the daemon relies on, and the lib module that owns it. */
const DECISIONS: Record<string, string> = {
  verifyGrant: '@pagespace/lib/env-bridge/grant',
  decideExecution: '@pagespace/lib/env-bridge/decide-execution',
  decodeFrame: '@pagespace/lib/env-bridge/frame-codec',
  reduceBridgeSession: '@pagespace/lib/env-bridge/bridge-session',
  verifyRevoke: '@pagespace/lib/env-bridge/machine-signatures',
  parseMachinePolicy: '@pagespace/lib/env-bridge/policy-types',
  grantRequestForFrame: '@pagespace/lib/env-bridge/grant-args',
  encodeHelloForSigning: '@pagespace/lib/env-bridge/machine-signatures',
  encodeResultForSigning: '@pagespace/lib/env-bridge/machine-signatures',
  isHardDeniedEnvVar: '@pagespace/lib/env-bridge/scrub-env',
};

describe('daemon structural invariants', () => {
  it('sees the daemon sources (sanity: the grep below is not vacuous)', () => {
    expect(daemonFiles.map(name)).toEqual(expect.arrayContaining(['env-bridge/ws-client.ts', 'env-bridge/exec-runner.ts', 'env-bridge/dispatcher.ts', 'commands/env/connect.ts']));
  });

  it('invariant 1: never listens — no createServer / .listen( / net.Server / WebSocketServer anywhere in the daemon', () => {
    for (const file of daemonFiles) {
      const source = read(file);
      expect(source, name(file)).not.toMatch(/createServer|\.listen\(|net\.Server|WebSocketServer|http\.Server/);
    }
  });

  it('child_process is imported in exactly ONE file: env-bridge/exec-runner.ts', () => {
    const importers = daemonFiles.filter((file) => /from 'node:child_process'|from 'child_process'|require\(['"](node:)?child_process/.test(read(file))).map(name);
    expect(importers).toEqual(['env-bridge/exec-runner.ts']);
  });

  it('every decision is IMPORTED from @pagespace/lib/env-bridge — none is re-declared locally', () => {
    for (const [fn, module] of Object.entries(DECISIONS)) {
      const importers = daemonFiles.filter((file) => new RegExp(`import[^;]*\\b${escapeRegExp(fn)}\\b[^;]*from '${escapeRegExp(module)}'`).test(read(file)));
      expect(importers.length, `${fn} must be imported from ${module}`).toBeGreaterThan(0);
      for (const file of daemonFiles) {
        expect(read(file), `${name(file)} re-declares ${fn}`).not.toMatch(new RegExp(`(function|const|let|var)\\s+${escapeRegExp(fn)}\\b`));
      }
    }
  });

  it('the dispatcher never imports anything that performs I/O directly (no node:fs, node:child_process, ws, node:net)', () => {
    const source = read(join(HERE, 'dispatcher.ts'));
    expect(source).not.toMatch(/from 'node:fs|from 'node:child_process|from 'ws'|from 'node:net|from 'node:http/);
  });

  it('the exec runner types its input as NormalizedRequest and nothing else', () => {
    const source = read(join(HERE, 'exec-runner.ts'));
    expect(source).toMatch(/run\(request: NormalizedRequest\)/);
    expect(source).not.toMatch(/GrantFrame|ExecutionRequest\b/);
  });
});
