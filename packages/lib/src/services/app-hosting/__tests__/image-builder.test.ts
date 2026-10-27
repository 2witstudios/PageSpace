/**
 * The Docker layer, with Docker mocked.
 *
 * The fake runner records the exact argv of every invocation, because most of what
 * can go wrong here is invisible at the level of "did it succeed": a token in argv
 * instead of stdin, an attestation flag left on (which turns the push into an index
 * with no measurable size), a digest taken from the build's own claim rather than
 * from the registry.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAndPush,
  ImageBuildError,
  probeBuilder,
  registryLogin,
  type BuilderProcessResult,
  type BuilderRunner,
  type BuilderRunOptions,
} from '../image-builder';

const DIGEST = `sha256:${'b'.repeat(64)}`;

interface Invocation {
  command: string;
  args: string[];
  options: BuilderRunOptions;
}

function runner(
  respond: (invocation: Invocation) => BuilderProcessResult | Promise<BuilderProcessResult>,
): { runner: BuilderRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  return {
    calls,
    runner: {
      async run(command, args, options = {}) {
        const invocation = { command, args, options };
        calls.push(invocation);
        return respond(invocation);
      },
    },
  };
}

const ok = (stdout = ''): BuilderProcessResult => ({ code: 0, stdout, stderr: '' });

describe('probing the builder', () => {
  it('asks for buildx, not just docker — BuildKit is what we need', async () => {
    const { runner: r, calls } = runner(() => ok('github.com/docker/buildx v0.14.0'));
    const result = await probeBuilder(r);
    expect(result).toEqual({ available: true, version: 'github.com/docker/buildx v0.14.0' });
    expect(calls[0].args).toEqual(['buildx', 'version']);
  });

  it('reports unavailable when docker is not installed, rather than throwing', async () => {
    const { runner: r } = runner(() => {
      throw new Error('spawn docker ENOENT');
    });
    expect(await probeBuilder(r)).toEqual({
      available: false,
      detail: 'spawn docker ENOENT',
    });
  });

  it('reports unavailable when the daemon is down', async () => {
    const { runner: r } = runner(() => ({
      code: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
    }));
    expect(await probeBuilder(r)).toEqual({
      available: false,
      detail: 'Cannot connect to the Docker daemon',
    });
  });

  it('reports unavailable when the process was killed by our timeout', async () => {
    const { runner: r } = runner(() => ({ code: null, stdout: '', stderr: '' }));
    const result = await probeBuilder(r);
    expect(result.available).toBe(false);
  });
});

describe('registry login', () => {
  it('sends the deploy token on stdin, never in argv', async () => {
    const { runner: r, calls } = runner(() => ok());
    await registryLogin(r, 'FlyV1 fm2_secret');
    expect(calls[0].args).toEqual([
      'login',
      'registry.fly.io',
      '--username',
      'x',
      '--password-stdin',
    ]);
    expect(calls[0].args.join(' ')).not.toContain('fm2_secret');
    expect(calls[0].options.stdin).toBe('FlyV1 fm2_secret');
  });

  it('throws a login-staged error without echoing the tool output back', async () => {
    const { runner: r } = runner(() => ({ code: 1, stdout: '', stderr: 'password: fm2_secret' }));
    await expect(registryLogin(r, 'FlyV1 fm2_secret')).rejects.toThrow(
      'docker login registry.fly.io failed (exit 1)',
    );
    await expect(registryLogin(r, 'FlyV1 fm2_secret')).rejects.not.toThrow(/fm2_secret/);
  });
});

function buildResponder(overrides: Partial<Record<string, BuilderProcessResult>> = {}) {
  return ({ args }: Invocation): BuilderProcessResult => {
    if (args[1] === 'build') return overrides.build ?? ok('pushed');
    if (args.includes('--format')) {
      return overrides.descriptor ?? ok(JSON.stringify({ digest: DIGEST, size: 500 }));
    }
    return (
      overrides.raw ??
      ok(JSON.stringify({ config: { size: 1000 }, layers: [{ size: 2000 }, { size: 4000 }] }))
    );
  };
}

const input = {
  flyAppName: 'pgs-app-abc',
  contextDir: '/srv/build/abc',
  dockerfile: '/srv/build/abc/Dockerfile',
  sourceRef: 'ws/app',
};

describe('build and push', () => {
  it('builds one platform with attestations off, so the push stays a plain manifest', async () => {
    const { runner: r, calls } = runner(buildResponder());
    await buildAndPush(r, input);
    expect(calls[0].args).toEqual([
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--file',
      '/srv/build/abc/Dockerfile',
      '--tag',
      'registry.fly.io/pgs-app-abc:src-ws-app',
      '--provenance=false',
      '--sbom=false',
      '--push',
      '/srv/build/abc',
    ]);
  });

  it('reads the digest back from the registry and measures the image by digest', async () => {
    const { runner: r, calls } = runner(buildResponder());
    expect(await buildAndPush(r, input)).toEqual({ digest: DIGEST, sizeBytes: 7000 });
    expect(calls[1].args).toContain('registry.fly.io/pgs-app-abc:src-ws-app');
    expect(calls[2].args).toContain(`registry.fly.io/pgs-app-abc@${DIGEST}`);
  });

  it('fails at the build stage when the build fails', async () => {
    const { runner: r } = runner(
      buildResponder({ build: { code: 1, stdout: '', stderr: 'no such file: package.json' } }),
    );
    await expect(buildAndPush(r, input)).rejects.toMatchObject({
      name: 'ImageBuildError',
      stage: 'build',
    });
    await expect(buildAndPush(r, input)).rejects.toThrow('no such file: package.json');
  });

  it('refuses to pin an image whose digest the registry will not confirm', async () => {
    const { runner: r } = runner(buildResponder({ descriptor: ok('{"digest":"sha256:oops"}') }));
    const error = await buildAndPush(r, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageBuildError);
    expect((error as ImageBuildError).stage).toBe('inspect');
  });

  it('fails when the pushed image cannot be inspected at all', async () => {
    const { runner: r } = runner(
      buildResponder({ descriptor: { code: 1, stdout: '', stderr: 'manifest unknown' } }),
    );
    await expect(buildAndPush(r, input)).rejects.toMatchObject({ stage: 'inspect' });
  });

  it('still succeeds when only the SIZE cannot be read — it is a cost signal, not a gate', async () => {
    const { runner: r } = runner(
      buildResponder({ raw: { code: 1, stdout: '', stderr: 'registry timeout' } }),
    );
    expect(await buildAndPush(r, input)).toEqual({ digest: DIGEST, sizeBytes: null });
  });

  it('still succeeds when measuring the size throws', async () => {
    let call = 0;
    const { runner: r } = runner((invocation) => {
      call += 1;
      if (call === 3) throw new Error('socket hang up');
      return buildResponder()(invocation);
    });
    expect(await buildAndPush(r, input)).toEqual({ digest: DIGEST, sizeBytes: null });
  });
});
