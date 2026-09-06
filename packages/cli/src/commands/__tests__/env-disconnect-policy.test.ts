import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createEnvDisconnectHandler, type EnvDisconnectHandlerDeps } from '../env/disconnect.js';
import { createEnvPolicyHandler, type EnvPolicyHandlerDeps } from '../env/policy.js';
import { pidFilePath } from '../env/connect.js';
import type { HandlerContext } from '../../handler-context.js';
import { parseArgv } from '../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';

const HOME = '/home/me';

function sink() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => void lines.push(chunk), text: () => lines.join('') };
}

function ctx(env: Record<string, string> = {}) {
  const out = sink();
  const err = sink();
  return { ctx: { stdout: out, stderr: err, env, isTTY: false } as unknown as HandlerContext, out, err };
}

/** What `run.ts` hands a handler: the parsed intent with the two-segment route path stripped from `args`. */
function intent(argv: string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error(parsed.message);
  return { ...parsed, args: parsed.args.slice(2) };
}

describe('pagespace env disconnect <enrollmentId>', () => {
  function deps(overrides: Partial<EnvDisconnectHandlerDeps> = {}) {
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const removePidFile = vi.fn<(path: string) => void>();
    return { kill, removePidFile, handler: createEnvDisconnectHandler({ homedir: HOME, readPid: () => 777, removePidFile, kill, ...overrides }) };
  }

  it('given no enrollmentId, should exit 2 with usage', async () => {
    const d = deps();
    const c = ctx();
    expect(await d.handler(c.ctx, intent(['env', 'disconnect']))).toBe(EXIT_USAGE_ERROR);
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('given a pid file, should send SIGTERM to that pid and exit 0 (Ctrl-C equivalent; the daemon never listens, so a signal is the only local channel)', async () => {
    const d = deps();
    const c = ctx();
    expect(await d.handler(c.ctx, intent(['env', 'disconnect', 'enr_1']))).toBe(EXIT_SUCCESS);
    expect(d.kill).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(c.out.text()).toMatch(/777/);
  });

  it('given no pid file, should exit 1 naming the path', async () => {
    const d = deps({ readPid: () => null });
    const c = ctx();
    expect(await d.handler(c.ctx, intent(['env', 'disconnect', 'enr_1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toContain(pidFilePath(HOME, 'enr_1'));
  });

  it('given a stale pid (ESRCH), should remove the pid file and exit 1', async () => {
    const d = deps({ kill: () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); } });
    const c = ctx();
    expect(await d.handler(c.ctx, intent(['env', 'disconnect', 'enr_1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(d.removePidFile).toHaveBeenCalledWith(pidFilePath(HOME, 'enr_1'));
    expect(c.err.text()).toMatch(/Stale pid file/);
  });

  it('--json prints the pid and signal', async () => {
    const d = deps();
    const c = ctx();
    await d.handler(c.ctx, intent(['env', 'disconnect', 'enr_1', '--json']));
    expect(JSON.parse(c.out.text())).toEqual({ enrollmentId: 'enr_1', pid: 777, signal: 'SIGTERM' });
  });
});

describe('pagespace env policy', () => {
  const VALID = { mode: 'ask', principals: ['u1'], ops: ['fs_read'], roots: ['/home/me/proj'], envAllowlist: ['CI'] };
  function deps(overrides: Partial<EnvPolicyHandlerDeps> & { content?: string | null; mode?: number; uidOfFile?: number } = {}) {
    const { content = JSON.stringify(VALID), mode = 0o100600, uidOfFile = 501, ...rest } = overrides;
    return createEnvPolicyHandler({
      homedir: HOME,
      uid: 501,
      statPolicy: () => (content === null ? null : { uid: uidOfFile, mode }),
      readPolicy: () => {
        if (content === null) throw new Error('ENOENT');
        return content;
      },
      ...rest,
    });
  }

  it('given a valid owner-only file, should print the policy in force (with defaults filled in) and exit 0', async () => {
    const c = ctx();
    expect(await deps()(c.ctx, intent(['env', 'policy']))).toBe(EXIT_SUCCESS);
    const text = c.out.text();
    expect(text).toContain(`Policy ${HOME}/.pagespace/env-policy.json`);
    expect(text).toMatch(/mode\s+ask/);
    expect(text).toMatch(/principals\s+u1/);
    expect(text).toMatch(/ops\s+fs_read \(pre-approved; anything else prompts\)/);
    expect(text).toMatch(/maxBytes\s+1048576/);
    expect(text).toMatch(/maxTimeoutMs\s+120000/);
  });

  it('should honour PAGESPACE_ENV_POLICY for the path', async () => {
    const c = ctx({ PAGESPACE_ENV_POLICY: '/etc/ps/policy.json' });
    await deps()(c.ctx, intent(['env', 'policy']));
    expect(c.out.text()).toContain('Policy /etc/ps/policy.json');
  });

  it('given a missing file, should exit 1 and explain deny-all', async () => {
    const c = ctx();
    expect(await deps({ content: null })(c.ctx, intent(['env', 'policy']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/No policy file/);
  });

  it('given a group-writable file, should exit 1 with the chmod fix', async () => {
    const c = ctx();
    expect(await deps({ mode: 0o100660 })(c.ctx, intent(['env', 'policy']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/chmod 600/);
  });

  it('given a file owned by another user, should exit 1 saying so', async () => {
    const c = ctx();
    expect(await deps({ uidOfFile: 0 })(c.ctx, intent(['env', 'policy']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/owned by another user/);
  });

  it('given an invalid policy, should exit 1 as invalid_schema', async () => {
    const c = ctx();
    expect(await deps({ content: JSON.stringify({ ...VALID, mode: 'yolo' }) })(c.ctx, intent(['env', 'policy']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/not a valid policy/);
  });

  it('--json prints path, policy, reason and digest, and exit code still reflects validity', async () => {
    const c = ctx();
    const content = JSON.stringify(VALID);
    expect(await deps({ content })(c.ctx, intent(['env', 'policy', '--json']))).toBe(EXIT_SUCCESS);
    expect(JSON.parse(c.out.text())).toEqual({ path: `${HOME}/.pagespace/env-policy.json`, policy: { ...VALID, maxBytes: 1_048_576, maxTimeoutMs: 120_000 }, reason: null, digest: createHash('sha256').update(content).digest('hex') });
    const c2 = ctx();
    expect(await deps({ content: null })(c2.ctx, intent(['env', 'policy', '--json']))).toBe(EXIT_RUNTIME_ERROR);
    expect(JSON.parse(c2.out.text())).toMatchObject({ policy: null, reason: 'missing', digest: '' });
  });
});
