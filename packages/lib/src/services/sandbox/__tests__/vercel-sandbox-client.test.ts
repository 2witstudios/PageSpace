import { describe, it, expect } from 'vitest';
import {
  buildSandboxCreateParams,
  resolveVercelCredentials,
  createVercelSandboxClient,
  SANDBOX_VM_LIFETIME_MS,
  type SandboxInstance,
  type SandboxSdk,
} from '../vercel-sandbox-client';
import { mapPolicyToSandboxOptions } from '../sandbox-options';
import { resolveExecutionPolicy, type ExecutionPolicy } from '../execution-policy';

const defaultOptions = mapPolicyToSandboxOptions({ policy: resolveExecutionPolicy() });

function fakeInstance(over: Partial<SandboxInstance> = {}): SandboxInstance {
  return {
    name: 'session-key-123',
    runCommand: async () => ({
      exitCode: 0,
      stdout: async () => 'out',
      stderr: async () => 'err',
    }),
    writeFiles: async () => {},
    readFileToBuffer: async () => Buffer.from('hello'),
    stop: async () => {},
    ...over,
  };
}

describe('resolveVercelCredentials', () => {
  it('given a complete triad, should return explicit credentials', () => {
    expect(
      resolveVercelCredentials({
        env: { VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'proj' },
      }),
    ).toEqual({ token: 't', teamId: 'team', projectId: 'proj' });
  });

  it('given a partial config, should return null so the SDK uses OIDC instead of half-authenticating', () => {
    expect(resolveVercelCredentials({ env: { VERCEL_TOKEN: 't' } })).toBeNull();
  });
});

describe('buildSandboxCreateParams', () => {
  it('given policy options, should set explicit caps and never inherit platform defaults', () => {
    const params = buildSandboxCreateParams({
      name: 'k',
      options: defaultOptions,
      env: { NODE_ENV: 'test' },
      credentials: null,
    });
    expect(params.name).toBe('k');
    // VM lifetime, not the per-run cap: a warm conversation sandbox must outlive
    // a single command and the idle-reclaim window.
    expect(params.timeout).toBe(SANDBOX_VM_LIFETIME_MS);
    expect(params.timeout as number).toBeGreaterThan(defaultOptions.timeoutMs);
    expect(params.resources).toEqual({ vcpus: defaultOptions.vcpus });
    expect(params.persistent).toBe(false);
    expect(params.env).toEqual({ NODE_ENV: 'test' });
  });

  it('given an empty egress allowlist, should provision deny-all egress', () => {
    const params = buildSandboxCreateParams({ name: 'k', options: defaultOptions, credentials: null });
    expect(params.networkPolicy).toBe('deny-all');
  });

  it('given a widened egress allowlist, should produce a host-scoped network policy', () => {
    const policy: ExecutionPolicy = {
      ...resolveExecutionPolicy(),
      egressAllowlist: ['registry.npmjs.org'],
    };
    const params = buildSandboxCreateParams({
      name: 'k',
      options: mapPolicyToSandboxOptions({ policy }),
      credentials: null,
    });
    expect(params.networkPolicy).not.toBe('deny-all');
  });

  it('given credentials, should spread them into the params', () => {
    const params = buildSandboxCreateParams({
      name: 'k',
      options: defaultOptions,
      credentials: { token: 't', teamId: 'team', projectId: 'proj' },
    });
    expect(params).toMatchObject({ token: 't', teamId: 'team', projectId: 'proj' });
  });
});

describe('createVercelSandboxClient', () => {
  it('given getOrCreate, should name the handle by the sandbox name', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sdk: SandboxSdk = {
      getOrCreate: async (params) => {
        calls.push(params);
        return fakeInstance({ name: 'k1' });
      },
      get: async () => fakeInstance(),
    };
    const client = createVercelSandboxClient({ sdk });
    const handle = await client.getOrCreate({ name: 'k1', options: defaultOptions });
    expect(handle.sandboxId).toBe('k1');
    expect(calls[0]?.name).toBe('k1');
  });

  it('given runCommand, should surface exitCode and resolve stdout/stderr strings', async () => {
    const sdk: SandboxSdk = {
      getOrCreate: async () =>
        fakeInstance({
          runCommand: async () => ({
            exitCode: 2,
            stdout: async () => 'hello',
            stderr: async () => 'boom',
          }),
        }),
      get: async () => fakeInstance(),
    };
    const client = createVercelSandboxClient({ sdk });
    const handle = await client.getOrCreate({ name: 'k', options: defaultOptions });
    const result = await handle.runCommand({ cmd: 'sh', args: ['-c', 'echo hi'] });
    expect(result).toEqual({ exitCode: 2, stdout: 'hello', stderr: 'boom' });
  });

  it('given a vanished sandbox, should resolve get to null rather than throwing', async () => {
    const sdk: SandboxSdk = {
      getOrCreate: async () => fakeInstance(),
      get: async () => {
        throw new Error('not found');
      },
    };
    const client = createVercelSandboxClient({ sdk });
    expect(await client.get({ sandboxId: 'gone' })).toBeNull();
  });

  it('given stop, should resolve the named sandbox and stop it', async () => {
    let stopped = false;
    const sdk: SandboxSdk = {
      getOrCreate: async () => fakeInstance(),
      get: async () => fakeInstance({ stop: async () => { stopped = true; } }),
    };
    const client = createVercelSandboxClient({ sdk });
    await client.stop({ sandboxId: 'k' });
    expect(stopped).toBe(true);
  });
});
