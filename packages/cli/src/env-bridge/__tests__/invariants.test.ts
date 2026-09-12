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
const DECISIONS: readonly string[] = ['verifyGrant', 'decideExecution', 'decodeFrame', 'reduceBridgeSession', 'verifyRevoke', 'parseMachinePolicy', 'grantRequestForFrame', 'encodeHelloForSigning', 'encodeResultForSigning', 'isHardDeniedEnvVar'];
const LIB_CORE = join(HERE, 'lib-core.ts');

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

  it('every decision is IMPORTED through env-bridge/lib-core.ts (the bundled seam over @pagespace/lib/env-bridge) — none is re-declared locally', () => {
    const core = read(LIB_CORE);
    for (const fn of DECISIONS) {
      expect(core, `${fn} must be re-exported by lib-core.ts`).toMatch(new RegExp(`export \\{[^}]*\\b${escapeRegExp(fn)}\\b[^}]*\\} from '@pagespace/lib/env-bridge/`));
      const importers = daemonFiles.filter((file) => file !== LIB_CORE && new RegExp(`import[^;]*\\b${escapeRegExp(fn)}\\b[^;]*from '(\\./|\\.\\./\\.\\./env-bridge/)lib-core\\.js'`).test(read(file)));
      expect(importers.length, `${fn} must be imported from lib-core.js`).toBeGreaterThan(0);
      for (const file of daemonFiles) {
        expect(read(file), `${name(file)} re-declares ${fn}`).not.toMatch(new RegExp(`(function|const|let|var)\\s+${escapeRegExp(fn)}\\b`));
      }
    }
  });

  it('lib-core.ts is the ONLY daemon file that names @pagespace/lib, and it contains nothing but re-exports', () => {
    const importers = daemonFiles.filter((file) => /['"]@pagespace\/lib/.test(read(file))).map(name);
    expect(importers).toEqual(['env-bridge/lib-core.ts']);
    const statements = read(LIB_CORE).split('\n').filter((line) => line.length > 0 && !line.startsWith('/**') && !line.startsWith(' *'));
    for (const line of statements) expect(line, line).toMatch(/^export (type )?\{[^}]*\} from '@pagespace\/lib\/env-bridge\/[a-z-]+';$/);
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

  describe('GA wave 2 — the approvals asymmetry: the machine file is authoritative for ALLOW; the server can only REVOKE', () => {
    const dispatcher = read(join(HERE, 'dispatcher.ts'));
    const store = read(join(HERE, 'approvals-store.ts'));

    it('approvals-store.ts reads and writes ONLY the local file (node:fs) — it has no network, no socket, no frame input', () => {
      const imports = [...store.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.every((s) => s === 'node:fs/promises' || s === 'node:path' || s === './lib-core.js' || s === './policy.js')).toBe(true);
      expect(store).not.toMatch(/fetch\(|from 'ws'|Frame\b/);
    });

    it('(a) the ONLY writer to the approvals store is the daemon\'s own remember() after a byte-compared allow (the terminal prompt, the click that matched) — no frame handler and no code path passes server-supplied data into approvals.remember()', () => {
      const writes = [...dispatcher.matchAll(/approvals\.remember\(/g)];
      expect(writes).toHaveLength(2);
      // Both sit inside handleGrant, AFTER the second decideExecution (the byte-compare) allowed, and BEFORE handleRevoke.
      const handleGrantStart = dispatcher.indexOf('const handleGrant');
      const revokeStart = dispatcher.indexOf('const handleRevoke');
      for (const w of writes) {
        expect(w.index).toBeGreaterThan(handleGrantStart);
        expect(w.index).toBeLessThan(revokeStart);
        const preceding = dispatcher.slice(handleGrantStart, w.index);
        expect(preceding).toMatch(/localApproval: \{ grantId: grant\.grantId, approvedAt: (deps\.now\(\)|now), request: (shown|frozen\.request) \}/);
        expect(preceding).toMatch(/kind (===|!==) 'allow'/);
      }
      // What is remembered comes from the daemon's OWN state (the verdict's subjects, the frozen challenge), never from the frame or the grant.
      for (const w of writes) {
        const call = dispatcher.slice(w.index, dispatcher.indexOf(';', w.index));
        expect(call).toMatch(/subjects(: frozen\.subjects)?,/);
        expect(call).not.toMatch(/frame\.|grant\.args|request\./);
      }
      expect(dispatcher.slice(revokeStart)).not.toMatch(/remember\(/);
      expect(dispatcher.slice(revokeStart)).toMatch(/approvals\.revoke\(frame\.approvalId\)/);
      // No other daemon file writes approvals at all.
      for (const file of daemonFiles) {
        if (name(file) === 'env-bridge/dispatcher.ts' || name(file) === 'env-bridge/approvals-store.ts') continue;
        expect(read(file), name(file)).not.toMatch(/\.remember\(/);
      }
    });

    it('(b) the frame codec has NO frame type that can ADD an approval — the only approval-shaped frame is `revoke` with `approvalId`', () => {
      const codec = readFileSync(join(HERE, '..', '..', '..', 'lib', 'src', 'env-bridge', 'frame-codec.ts'), 'utf8');
      const types = [...codec.matchAll(/z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1]);
      expect(types.length).toBeGreaterThan(10);
      // The only approval-shaped types: `revoke` (server → machine, DELETES one) and the machine → server ACK of that deletion. Neither can add.
      expect(types.filter((t) => /approv|allow|remember/.test(t as string))).toEqual(['approval_revoke_result']);
      expect(codec).toMatch(/MACHINE_TO_SERVER_FRAME_TYPES[^;]*'approval_revoke_result'/);
      expect(codec).not.toMatch(/SERVER_TO_MACHINE_FRAME_TYPES[^;]*'approval_revoke_result'/);
      // `approvalId` appears on exactly those two schemas. `approvalIntent` never does — it lives inside the opaque grant, parsed only by verifyGrant.
      const approvalIdLines = codec.split('\n').filter((line) => line.includes('approvalId') && !line.trimStart().startsWith('/**') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      expect(approvalIdLines).toHaveLength(2);
      expect(approvalIdLines.some((line) => /z\.literal\('revoke'\)/.test(line))).toBe(true);
      expect(approvalIdLines.some((line) => /z\.literal\('approval_revoke_result'\)/.test(line))).toBe(true);
      expect(codec).not.toMatch(/approvalIntent/);
      // And the daemon never routes a frame by an approval-shaped type.
      expect(dispatcher).not.toMatch(/frame\.type === '(approve|approval|allow)/);
    });

    /**
     * HARDENING B, LEAF B5 — the same asymmetry, for the thing that PROVES the
     * owner. The pinned credential set is the root of the whole check: if
     * anything on the wire could extend it, a server could pin its own key and
     * answer its own cards. So nothing may write it except `env enroll`.
     */
    it('(c) NO frame type can add an owner credential, and no daemon file writes the pinned set — it is written once, by enroll', () => {
      const codec = readFileSync(join(HERE, '..', '..', '..', 'lib', 'src', 'env-bridge', 'frame-codec.ts'), 'utf8');
      // The wire has no vocabulary for it at all: not the field, not the concept.
      expect(codec).not.toMatch(/ownerApproval|ownerCredential|publicKeyCose|credentialId/);
      // Nor does any daemon file assign one, or grow the pinned list.
      for (const file of daemonFiles) {
        expect(read(file), name(file)).not.toMatch(/ownerApproval\s*=[^=]|credentials\.push/);
      }
      // The daemon only ever READS it: no file that mentions it also writes to the credential store.
      const writers = daemonFiles.filter((file) => /ownerApproval/.test(read(file)) && /\.set\(/.test(read(file))).map(name);
      expect(writers).toEqual([]);
      // The ONE writer is `env enroll`, outside the daemon, at the trust-on-first-use moment.
      const enroll = read(join(HERE, '..', 'commands', 'env.ts'));
      expect(enroll).toMatch(/pinnedOwnerApprovalFromEnrollment\(result\.ownerCredentials\)/);
    });
    it('GA wave 3: the `pause` path can add nothing and delete no key — handlePause never touches approvals, remember, or deleteKey, and the codec\'s pause schema carries no approvalId', () => {
      const pauseStart = dispatcher.indexOf('const handlePause');
      const pauseEnd = dispatcher.indexOf('\n  return {', pauseStart);
      expect(pauseStart).toBeGreaterThan(0);
      const body = dispatcher.slice(pauseStart, pauseEnd);
      expect(body).not.toMatch(/remember\(|approvals\.|deleteKey|revoke_verified/);
      expect(body).toMatch(/execRunner\.killAll\(\)/);
      expect(body).toMatch(/challenges\?\.clear\(\)/);
      const codec = readFileSync(join(HERE, '..', '..', '..', 'lib', 'src', 'env-bridge', 'frame-codec.ts'), 'utf8');
      const pauseLine = codec.split('\n').find((line) => line.includes("z.literal('pause')"));
      expect(pauseLine).toBeDefined();
      expect(pauseLine).not.toMatch(/approvalId|grant/);
    });

    it('decideExecution is fed the machine\'s own approvals (deps.approvals) and nothing carried by the grant or the frame', () => {
      expect(dispatcher).toMatch(/approvals: \{ entries: deps\.approvals\?\.entries\(\) \?\? \[\]/);
      expect(dispatcher).not.toMatch(/grant\.approvals|frame\.approvals/);
    });
  });

  describe('GA wave 1 — the two docblocks that used to lie', () => {
    const dispatcher = read(join(HERE, 'dispatcher.ts'));
    const auditLog = read(join(HERE, 'audit-log.ts'));

    it('dispatcher.ts no longer carries a "permissive stand-in" for the server policy: the constant is named for what it is — the server\'s say is the signature over `op`', () => {
      expect(dispatcher).not.toContain('DAEMON_SERVER_POLICY');
      expect(dispatcher).not.toMatch(/permissive stand-in/);
      expect(dispatcher).toMatch(/^const SERVER_POLICY_CARRIED_BY_SIGNATURE: ServerPolicy = \{ ops: \[\.\.\.GRANT_OPS\], checkpoint: false \};$/m);
      // The docblock says WHY every op may pass this input: the server already refused, at signing, every op it does not allow (decideSign), and a grant's `op` is under the signature the daemon verifies first.
      const docblock = dispatcher.slice(0, dispatcher.indexOf('export const SERVER_POLICY_CARRIED_BY_SIGNATURE'));
      expect(docblock).toMatch(/decideSign/);
      expect(docblock).toMatch(/signature over `op`/);
      expect(dispatcher).toMatch(/serverPolicy: SERVER_POLICY_CARRIED_BY_SIGNATURE,/);
    });

    it('audit-log.ts claims the server-side join again — and now names the table that makes it true (GA wave 3 wrote the other side)', () => {
      const docblock = auditLog.slice(0, auditLog.indexOf('import type'));
      // The wave 1 wording ("no server-side row") is gone: it would be the lie now.
      expect(docblock).not.toMatch(/no server-side (audit )?row/i);
      expect(docblock).not.toMatch(/ONE side of that join/);
      expect(docblock).toMatch(/drive_env_grant_audit/);
      expect(docblock).toMatch(/joins? (to|the two)/);
      expect(docblock).toMatch(/grantId/);
    });
  });
});
