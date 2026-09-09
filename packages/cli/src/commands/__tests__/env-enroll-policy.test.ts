/**
 * `pagespace env enroll` scaffolds the machine policy with `principals:
 * [<ownerId>]` (D-6, invariant 13 — defence in depth: the machine refuses
 * everyone but its owner even if the server is wrong). An existing policy is
 * never overwritten; a hand-edited one naming others is the owner's call.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEnvEnrollHandler, type EnvEnrollHandlerDeps } from '../env.js';
import { createEnvPolicyHandler } from '../env/policy.js';
import type { HandlerContext } from '../../handler-context.js';
import { parseArgv } from '../../argv/parse.js';
import { EXIT_SUCCESS } from '../../exit-codes.js';
import type { CredentialStore } from '../../credentials/store.js';
import type { HostCredential } from '../../credentials/serialize.js';
import type { OpenedPolicyFile } from '../../env-bridge/policy.js';

const HOME = '/home/me';
const CWD = '/home/me/code/project';
const OWNER = 'usr_owner';

function sink() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => void lines.push(chunk), text: () => lines.join('') };
}

function ctx(env: Record<string, string> = {}) {
  const out = sink();
  const err = sink();
  return { ctx: { stdout: out, stderr: err, env, isTTY: false } as unknown as HandlerContext, out, err };
}

function intent(argv: string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error(parsed.message);
  return { ...parsed, args: parsed.args.slice(2) };
}

function memoryStore(): CredentialStore {
  const hosts = new Map<string, HostCredential>();
  return {
    async get(host, profile) {
      return hosts.get(`${host}|${profile ?? ''}`) ?? null;
    },
    async set(host, credential, profile) {
      hosts.set(`${host}|${profile ?? ''}`, credential);
    },
    async delete(host, profile) {
      hosts.delete(`${host}|${profile ?? ''}`);
    },
    async list() {
      return [];
    },
  };
}

const ENROLLED = { enrollmentId: 'enr_1', envId: 'env_1', serverKeyId: 'k1', serverPublicKey: 'U0VSVkVS', ownerId: OWNER, serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } };

function deps(over: Partial<EnvEnrollHandlerDeps> & { existing?: OpenedPolicyFile | null; response?: Record<string, unknown> } = {}) {
  const { existing = null, response = ENROLLED, ...rest } = over;
  const writes: Array<{ path: string; content: string }> = [];
  const handler = createEnvEnrollHandler({
    createCredentialStore: memoryStore,
    generateKeypair: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    fetch: (async () => new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch,
    now: () => 1_700_000_000_000,
    homedir: HOME,
    cwd: () => CWD,
    openPolicy: () => existing,
    writePolicyFile: async (path, content) => {
      writes.push({ path, content });
    },
    ...rest,
  });
  return { handler, writes };
}

const enroll = (d: ReturnType<typeof deps>, c: ReturnType<typeof ctx>) => d.handler(c.ctx, intent(['env', 'enroll', 'enr_1', 'CODE', '--host', 'https://ps.test']));

describe('pagespace env enroll — scaffolds the policy with the OWNER as its only principal (D-6)', () => {
  it('given no policy file, should write ~/.pagespace/env-policy.json with principals [ownerId], mode ask, no pre-approved ops, and the current directory as the only root — and say so', async () => {
    const d = deps();
    const c = ctx();
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes).toHaveLength(1);
    expect(d.writes[0]!.path).toBe(`${HOME}/.pagespace/env-policy.json`);
    const policy = JSON.parse(d.writes[0]!.content) as Record<string, unknown>;
    expect(policy).toEqual({ mode: 'ask', principals: [OWNER], ops: ['fs_read', 'fs_write'], roots: [CWD], envAllowlist: [] });
    expect(c.out.text()).toContain(`${HOME}/.pagespace/env-policy.json`);
    expect(c.out.text()).toContain(OWNER);
  });

  it('given PAGESPACE_ENV_POLICY, should scaffold at THAT path', async () => {
    const d = deps();
    const c = ctx({ PAGESPACE_ENV_POLICY: '/etc/ps/policy.json' });
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes[0]!.path).toBe('/etc/ps/policy.json');
  });

  it('given an EXISTING policy file, should never overwrite it — the owner\'s file is the owner\'s — say it was kept, and print the diff of what it would have written', async () => {
    const existing: OpenedPolicyFile = { uid: 501, mode: 0o100600, content: JSON.stringify({ mode: 'allowlist', principals: [OWNER], ops: ['fs_read'], roots: ['/srv'], envAllowlist: [] }, null, 2) + '\n' };
    const d = deps({ existing });
    const c = ctx();
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes).toHaveLength(0);
    expect(c.out.text()).toMatch(/kept/i);
    const out = c.out.text();
    // Unified-style: lines only the existing file has are `-`, lines only the scaffold has are `+`.
    expect(out).toMatch(/^-\s+"mode": "allowlist",$/m);
    expect(out).toMatch(/^\+\s+"mode": "ask",$/m);
    expect(out).toMatch(/^\+\s+"fs_write"$/m);
    expect(out).toMatch(/^-\s+"\/srv"$/m);
    expect(out).toMatch(new RegExp(`^\\+\\s+"${CWD}"$`, 'm'));
  });

  describe('GA wave 2 · leaf 3 — Tier A file ops headless, Tier B exec never', () => {
    it('given a serverPolicy allowing fs_read only, should scaffold ops [fs_read]', async () => {
      const d = deps({ response: { ...ENROLLED, serverPolicy: { ops: ['fs_read'], checkpoint: false } } });
      const c = ctx();
      expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
      expect((JSON.parse(d.writes[0]!.content) as { ops: string[] }).ops).toEqual(['fs_read']);
    });

    it('given a serverPolicy that ALLOWS exec, should NEVER write exec into the machine ops — exec reaches the ask verdict by construction', async () => {
      const d = deps({ response: { ...ENROLLED, serverPolicy: { ops: ['exec', 'fs_write', 'fs_read'], checkpoint: false } } });
      const c = ctx();
      expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
      const policy = JSON.parse(d.writes[0]!.content) as { ops: string[] };
      expect(policy.ops).toEqual(['fs_read', 'fs_write']);
      expect(policy.ops).not.toContain('exec');
      expect(c.out.text()).toMatch(/exec/);
      expect(c.out.text()).toMatch(/ask/);
    });

    it('given a serverPolicy allowing only exec, should scaffold ops [] and say so', async () => {
      const d = deps({ response: { ...ENROLLED, serverPolicy: { ops: ['exec'], checkpoint: false } } });
      const c = ctx();
      expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
      expect((JSON.parse(d.writes[0]!.content) as { ops: string[] }).ops).toEqual([]);
    });

    it('given a serverPolicy the strict shape refuses (unknown op, missing field, not an object), should scaffold ops [] — never guess', async () => {
      for (const serverPolicy of [{ ops: ['fs_read', 'pty_open', 'root'], checkpoint: false }, { ops: ['fs_read'] }, 'fs_read', null, { ops: 'fs_read', checkpoint: false }]) {
        const d = deps({ response: { ...ENROLLED, serverPolicy } });
        const c = ctx();
        expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
        expect((JSON.parse(d.writes[0]!.content) as { ops: string[] }).ops, JSON.stringify(serverPolicy)).toEqual([]);
      }
    });

    it('given an older server that did not answer serverPolicy, should scaffold ops []', async () => {
      const { serverPolicy: _omitted, ...withoutPolicy } = ENROLLED;
      const d = deps({ response: withoutPolicy });
      const c = ctx();
      expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
      expect((JSON.parse(d.writes[0]!.content) as { ops: string[] }).ops).toEqual([]);
    });

    it('the scaffold is always mode ask with principals [owner] and mode 600 (the writer is the 0600 one), whatever the server policy', async () => {
      const d = deps({ response: { ...ENROLLED, serverPolicy: { ops: ['exec', 'fs_read'], checkpoint: false } } });
      const c = ctx();
      await enroll(d, c);
      expect(JSON.parse(d.writes[0]!.content)).toMatchObject({ mode: 'ask', principals: [OWNER] });
    });
  });

  it('given an existing policy that does NOT name the owner, should keep it and WARN that the owner\'s own requests will be denied principal_not_allowed', async () => {
    const existing: OpenedPolicyFile = { uid: 501, mode: 0o100600, content: JSON.stringify({ mode: 'ask', principals: ['usr_someone_else'], ops: [], roots: ['/srv'], envAllowlist: [] }) };
    const d = deps({ existing });
    const c = ctx();
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes).toHaveLength(0);
    expect(c.err.text()).toContain('principal_not_allowed');
    expect(c.err.text()).toContain(OWNER);
  });

  it('given a server that did not answer ownerId (an older deployment), should enroll, scaffold nothing, and say why', async () => {
    const { ownerId: _omitted, ...withoutOwner } = ENROLLED;
    const d = deps({ response: withoutOwner });
    const c = ctx();
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes).toHaveLength(0);
    expect(c.err.text()).toMatch(/owner/i);
  });

  it("given enrol runs from '/' (a root the strict parser rejects), should write NOTHING, exit non-zero from the scaffold step, and say the enrollment succeeded, exactly why no policy was written, and what to write (Codex P2)", async () => {
    const d = deps({ cwd: () => '/' });
    const c = ctx();
    expect(await enroll(d, c)).not.toBe(EXIT_SUCCESS);
    expect(d.writes).toHaveLength(0);
    expect(c.out.text()).toContain('Enrolled this machine as environment env_1');
    const err = c.err.text();
    expect(err).toMatch(/filesystem root/i);
    expect(err).toContain(`${HOME}/.pagespace/env-policy.json`);
    expect(err).toContain('"roots"');
    expect(err).toContain(OWNER);
  });

  it('given the policy write fails, should still report the enrollment as done (the key is pinned), print the failure — never the key — and exit non-zero for the scaffold step', async () => {
    const d = deps({
      writePolicyFile: async () => {
        throw new Error('EROFS');
      },
    });
    const c = ctx();
    expect(await enroll(d, c)).not.toBe(EXIT_SUCCESS);
    expect(c.err.text()).toContain('EROFS');
    expect(c.out.text()).toContain('Enrolled this machine as environment env_1');
    expect(`${c.out.text()}${c.err.text()}`).not.toContain('PRIV');
  });

  it('with --json, should include the policy path and whether it was scaffolded', async () => {
    const d = deps();
    const c = ctx();
    expect(await d.handler(c.ctx, intent(['env', 'enroll', 'enr_1', 'CODE', '--host', 'https://ps.test', '--json']))).toBe(EXIT_SUCCESS);
    expect(JSON.parse(c.out.text())).toMatchObject({ envId: 'env_1', ownerId: OWNER, policy: { path: `${HOME}/.pagespace/env-policy.json`, scaffolded: true } });
  });
});

describe('pagespace env policy — a policy naming OTHER users is honoured, and says what that means (D-6)', () => {
  const policy = (principals: string[]) => ({ uid: 501, mode: 0o100600, content: JSON.stringify({ mode: 'ask', principals, ops: [], roots: ['/srv'], envAllowlist: [] }) });
  const handler = (principals: string[]) => createEnvPolicyHandler({ homedir: HOME, uid: 501, openPolicy: () => policy(principals) });

  it('given one principal, should print the policy with no warning', async () => {
    const c = ctx();
    expect(await handler([OWNER])(c.ctx, intent(['env', 'policy']))).toBe(EXIT_SUCCESS);
    expect(c.err.text()).toBe('');
  });

  it('given more than one principal, should still exit 0 (in force) but warn, naming D-6: every listed user can run commands as you on this machine, and PageSpace itself only ever binds the owner', async () => {
    const c = ctx();
    expect(await handler([OWNER, 'usr_friend'])(c.ctx, intent(['env', 'policy']))).toBe(EXIT_SUCCESS);
    expect(c.err.text()).toContain('D-6');
    expect(c.err.text()).toContain('usr_friend');
    expect(c.err.text()).toMatch(/as you/);
  });
});

describe('pagespace env policy — exec in an allowlist policy is honoured, and the daemon is LOUD about it (GA wave 3, leaf 7; Codex P1 on #2584)', () => {
  const handler = (mode: string, ops: string[]) => createEnvPolicyHandler({ homedir: HOME, uid: 501, openPolicy: () => ({ uid: 501, mode: 0o100600, content: JSON.stringify({ mode, principals: [OWNER], ops, roots: ['/srv'], envAllowlist: [] }) }) });

  it('given mode allowlist with exec in ops, should exit 0 but print ONE line naming the consequence (commands run without a click) and the way back (remove exec from ops)', async () => {
    const c = ctx();
    expect(await handler('allowlist', ['fs_read', 'exec'])(c.ctx, intent(['env', 'policy']))).toBe(EXIT_SUCCESS);
    const lines = c.err.text().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/exec is allowlisted: commands run on this machine without a click/);
    expect(lines[0]).toMatch(/remove exec from ops to restore the approval prompt/);
  });

  it('given ask mode with exec, or allowlist without exec, should print nothing', async () => {
    for (const [mode, ops] of [['ask', ['exec']], ['allowlist', ['fs_read', 'fs_write']]] as const) {
      const c = ctx();
      expect(await handler(mode, [...ops])(c.ctx, intent(['env', 'policy']))).toBe(EXIT_SUCCESS);
      expect(c.err.text()).toBe('');
    }
  });
});
