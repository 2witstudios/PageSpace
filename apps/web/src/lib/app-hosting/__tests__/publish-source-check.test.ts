import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCommand = vi.fn();
const writeFiles = vi.fn();
const clientGet = vi.fn();

vi.mock('@/lib/sandbox/sprites-client', () => ({
  createProductionSpritesSandboxClient: vi.fn(async () => ({ get: clientGet })),
}));

vi.mock('@pagespace/lib/services/sandbox/sandbox-paths', () => ({
  SANDBOX_ROOT: '/workspace',
}));

import { ensureBuildableSource } from '../publish-source-check';
import { GENERATED_DOCKERFILE_MARKER } from '@pagespace/lib/services/app-hosting/dockerfile-synthesis-core';

type Cmd = { cmd: string; args: string[] };

function testF(present: Set<string>) {
  return ({ cmd, args }: Cmd) => {
    if (cmd !== 'test' || args[0] !== '-f') throw new Error(`unexpected inspect command: ${cmd} ${args.join(' ')}`);
    const path = args[1];
    return Promise.resolve({ exitCode: present.has(path) ? 0 : 1, stdout: '', stderr: '' });
  };
}

describe('ensureBuildableSource', () => {
  beforeEach(() => {
    runCommand.mockReset();
    writeFiles.mockReset();
    clientGet.mockReset();
    clientGet.mockResolvedValue({ runCommand, writeFiles });
  });

  it('refuses immediately with no_live_sandbox when there is no sandboxId', async () => {
    const result = await ensureBuildableSource(null);
    expect(result).toEqual({ ok: false, reason: 'no_live_sandbox' });
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('never overwrites a user-authored Dockerfile at the root, and never even inspects package.json/index.html', async () => {
    // A root with a real Dockerfile plus package.json — the Dockerfile must
    // win outright per D1, and the presence check must be a direct `test -f`
    // per file, not a listing a large root could truncate into a wrong
    // answer.
    const present = new Set(['/workspace/Dockerfile', '/workspace/package.json']);
    runCommand.mockImplementation((call: Cmd) => {
      if (call.cmd === 'test') return testF(present)(call);
      if (call.cmd === 'head') return Promise.resolve({ exitCode: 0, stdout: 'FROM ubuntu:22.04\n', stderr: '' });
      throw new Error(`unexpected cmd ${call.cmd} in overwrite-invariant test`);
    });

    const result = await ensureBuildableSource('sandbox-1');

    expect(result).toEqual({ ok: true });
    expect(writeFiles).not.toHaveBeenCalled();
    // The package.json branch is only reached to build a Node plan when
    // synthesizing — a user Dockerfile short-circuits before that, so `cat`
    // must never run.
    expect(runCommand).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'cat' }));
  });

  it('regenerates over a Dockerfile it wrote itself (carries the generated marker on line 1)', async () => {
    const present = new Set(['/workspace/Dockerfile', '/workspace/package.json']);
    runCommand.mockImplementation((call: Cmd) => {
      if (call.cmd === 'test') return testF(present)(call);
      if (call.cmd === 'head') return Promise.resolve({ exitCode: 0, stdout: `${GENERATED_DOCKERFILE_MARKER}\n`, stderr: '' });
      if (call.cmd === 'cat') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ scripts: { start: 'node server.js' } }), stderr: '' });
      throw new Error(`unexpected cmd ${call.cmd}`);
    });
    writeFiles.mockResolvedValue(undefined);

    const result = await ensureBuildableSource('sandbox-1');

    expect(result).toEqual({ ok: true });
    expect(writeFiles).toHaveBeenCalledTimes(1);
    const [files] = writeFiles.mock.calls[0] as [Array<{ path: string; content: string }>];
    const paths = files.map((f) => f.path);
    expect(paths).toContain('/workspace/Dockerfile');
    expect(paths).toContain('/workspace/.dockerignore');
  });

  it('synthesizes a Node Dockerfile and a .dockerignore when there is no Dockerfile at all', async () => {
    const present = new Set(['/workspace/package.json']);
    runCommand.mockImplementation((call: Cmd) => {
      if (call.cmd === 'test') return testF(present)(call);
      if (call.cmd === 'cat') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ scripts: { start: 'node server.js' } }), stderr: '' });
      throw new Error(`unexpected cmd ${call.cmd}`);
    });
    writeFiles.mockResolvedValue(undefined);

    const result = await ensureBuildableSource('sandbox-1');

    expect(result).toEqual({ ok: true });
    const [files] = writeFiles.mock.calls[0] as [Array<{ path: string; content: string }>];
    const dockerfile = files.find((f) => f.path === '/workspace/Dockerfile')!;
    const dockerignore = files.find((f) => f.path === '/workspace/.dockerignore')!;
    expect(dockerfile.content.startsWith(GENERATED_DOCKERFILE_MARKER)).toBe(true);
    expect(dockerfile.content).toContain('USER bun');
    expect(dockerignore.content).toContain('node_modules');
    expect(dockerignore.content).toContain('.env*');
    expect(dockerignore.content).toContain('.git');
  });

  it('refuses with no_recognizable_source when nothing at the root is recognizable', async () => {
    runCommand.mockImplementation(testF(new Set()));

    const result = await ensureBuildableSource('sandbox-1');

    expect(result).toEqual({ ok: false, reason: 'no_recognizable_source' });
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it('treats a non-string scripts.start value as absent, refusing rather than generating an unrunnable Dockerfile', async () => {
    // A malformed package.json (`"start": {}`) must not be treated as a
    // valid start command just because it's truthy — `parsePackageJson` has
    // to filter it out before `planDockerfileSynthesis` ever sees it.
    const present = new Set(['/workspace/package.json']);
    runCommand.mockImplementation((call: Cmd) => {
      if (call.cmd === 'test') return testF(present)(call);
      if (call.cmd === 'cat') return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ scripts: { start: {} } }), stderr: '' });
      throw new Error(`unexpected cmd ${call.cmd}`);
    });

    const result = await ensureBuildableSource('sandbox-1');

    expect(result).toEqual({ ok: false, reason: 'node_missing_start_command' });
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it('treats an inspect failure (test -f itself erroring) as inspect_failed, never as absent', async () => {
    runCommand.mockImplementation(({ cmd, args }: Cmd) => {
      if (cmd === 'test' && args[1] === '/workspace/Dockerfile') {
        return Promise.resolve({ exitCode: 2, stdout: '', stderr: 'permission denied' });
      }
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    });

    const result = await ensureBuildableSource('sandbox-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('inspect_failed');
    expect(writeFiles).not.toHaveBeenCalled();
  });
});
