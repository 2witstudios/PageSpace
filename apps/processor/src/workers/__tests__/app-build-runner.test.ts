/**
 * The two Node-only seams, against the real filesystem and real subprocesses.
 *
 * Mocking `spawn` here would test nothing: the questions are whether a source ref
 * can escape its root, and whether the runner really is shell-free, really captures
 * output, and really kills a hung process. All three are properties of the actual
 * OS calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuilderRunner, materializeBuildSource } from '../app-build-runner';

let root = '';
const originalRoot = process.env.APP_BUILD_SOURCE_ROOT;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pagespace-build-root-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.APP_BUILD_SOURCE_ROOT;
  else process.env.APP_BUILD_SOURCE_ROOT = originalRoot;
});

beforeEach(() => {
  process.env.APP_BUILD_SOURCE_ROOT = root;
});

describe('materializeBuildSource', () => {
  it('refuses when no build root is configured — this processor is not a build host', async () => {
    delete process.env.APP_BUILD_SOURCE_ROOT;
    await expect(materializeBuildSource('anything')).rejects.toThrow(
      /APP_BUILD_SOURCE_ROOT is not set/,
    );
  });

  it('refuses a ref that climbs out of the root', async () => {
    await expect(materializeBuildSource('../../etc')).rejects.toThrow(/outside the configured/);
  });

  it('refuses an absolute ref, which path.resolve would otherwise honour', async () => {
    await expect(materializeBuildSource('/etc')).rejects.toThrow(/outside the configured/);
  });

  it('refuses a sibling directory whose path shares the root’s name as a prefix', async () => {
    // `${root}-evil` is a perfectly good build context — a real directory with a
    // real Dockerfile — that is NOT inside the root. Its path starts with the
    // root's path as a plain STRING, so a `startsWith(root)` check would admit it;
    // requiring the separator is what makes this a refusal instead of an escape.
    const sibling = `${root}-evil`;
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'Dockerfile'), 'FROM alpine\n');
    try {
      await expect(
        materializeBuildSource(`../${path.basename(sibling)}`),
      ).rejects.toThrow(/outside the configured/);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a ref that is not a directory', async () => {
    await writeFile(path.join(root, 'a-file'), 'x');
    await expect(materializeBuildSource('a-file')).rejects.toThrow(/not a directory/);
  });

  it('refuses a directory with no Dockerfile — an app must declare how it builds', async () => {
    await mkdir(path.join(root, 'no-dockerfile'), { recursive: true });
    await expect(materializeBuildSource('no-dockerfile')).rejects.toThrow(/no Dockerfile/);
  });

  it('resolves a well-formed source ref to a context and its Dockerfile', async () => {
    const dir = path.join(root, 'ws', 'app');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n');

    const source = await materializeBuildSource('ws/app');
    expect(source.contextDir).toBe(dir);
    expect(source.dockerfile).toBe(path.join(dir, 'Dockerfile'));
    // Nothing was copied, so cleanup is a no-op that must still resolve.
    await expect(source.cleanup()).resolves.toBeUndefined();
  });
});

describe('createBuilderRunner', () => {
  const runner = createBuilderRunner();

  it('captures stdout and the exit code', async () => {
    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(result).toEqual({ code: 0, stdout: 'hi', stderr: '' });
  });

  it('captures stderr and a non-zero exit', async () => {
    const result = await runner.run(process.execPath, [
      '-e',
      'process.stderr.write("bad"); process.exit(3)',
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe('bad');
  });

  it('passes stdin through, which is how the deploy token travels', async () => {
    const result = await runner.run(process.execPath, [
      '-e',
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))',
    ], { stdin: 'token' });
    expect(result.stdout).toBe('TOKEN');
  });

  it('runs without a shell — an argument is an argument, never syntax', async () => {
    const result = await runner.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1] ?? "")',
      '; touch /tmp/pwned',
    ]);
    // Through a shell this would have been a second command; here it is argv[1].
    expect(result.stdout).toBe('; touch /tmp/pwned');
  });

  it('kills a hung process at the timeout and reports a null exit code', async () => {
    const result = await runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 300,
    });
    expect(result.code).toBe(null);
  });

  it('rejects when the binary does not exist, which is the builder-probe path', async () => {
    await expect(
      runner.run('definitely-not-a-real-binary-xyz', ['--version']),
    ).rejects.toThrow(/ENOENT/);
  });
});
