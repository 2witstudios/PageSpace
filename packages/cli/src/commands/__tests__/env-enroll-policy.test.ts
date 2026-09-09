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

const ENROLLED = { enrollmentId: 'enr_1', envId: 'env_1', serverKeyId: 'k1', serverPublicKey: 'U0VSVkVS', ownerId: OWNER };

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
    expect(policy).toEqual({ mode: 'ask', principals: [OWNER], ops: [], roots: [CWD], envAllowlist: [] });
    expect(c.out.text()).toContain(`${HOME}/.pagespace/env-policy.json`);
    expect(c.out.text()).toContain(OWNER);
  });

  it('given PAGESPACE_ENV_POLICY, should scaffold at THAT path', async () => {
    const d = deps();
    const c = ctx({ PAGESPACE_ENV_POLICY: '/etc/ps/policy.json' });
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes[0]!.path).toBe('/etc/ps/policy.json');
  });

  it('given an EXISTING policy file, should never overwrite it — the owner\'s file is the owner\'s — and say it was kept', async () => {
    const existing: OpenedPolicyFile = { uid: 501, mode: 0o100600, content: JSON.stringify({ mode: 'allowlist', principals: [OWNER], ops: ['fs_read'], roots: ['/srv'], envAllowlist: [] }) };
    const d = deps({ existing });
    const c = ctx();
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
    expect(d.writes).toHaveLength(0);
    expect(c.out.text()).toMatch(/kept/i);
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

  it('given the policy write fails, should still report the enrollment as done (the key is pinned) and print the failure — never the key', async () => {
    const d = deps({
      writePolicyFile: async () => {
        throw new Error('EROFS');
      },
    });
    const c = ctx();
    expect(await enroll(d, c)).toBe(EXIT_SUCCESS);
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
