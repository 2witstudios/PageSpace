import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCommand = vi.fn();
const readFileToBuffer = vi.fn();
const clientGet = vi.fn();

vi.mock('@/lib/sandbox/sprites-client', () => ({
  createProductionSpritesSandboxClient: vi.fn(async () => ({ get: clientGet })),
}));

vi.mock('@pagespace/lib/services/sandbox/sandbox-paths', () => ({
  SANDBOX_ROOT: '/workspace',
}));

let onPrem = false;
vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: () => onPrem,
}));

import { snapshotEnvFilesystem, ENV_SNAPSHOT_MAX_BYTES } from '../env-snapshot';

describe('snapshotEnvFilesystem', () => {
  beforeEach(() => {
    runCommand.mockReset();
    readFileToBuffer.mockReset();
    clientGet.mockReset();
    clientGet.mockResolvedValue({ runCommand, readFileToBuffer });
    onPrem = false;
  });

  it('refuses immediately with no_live_sandbox when there is no sandboxId', async () => {
    const result = await snapshotEnvFilesystem(null);
    expect(result).toEqual({ ok: false, reason: 'no_live_sandbox' });
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('refuses with onprem_unsupported before ever creating a Fly Sprites client — external integrations are never reachable on-prem', async () => {
    onPrem = true;
    const result = await snapshotEnvFilesystem('sandbox-1');
    expect(result).toEqual({ ok: false, reason: 'onprem_unsupported' });
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('stats the tarball BEFORE reading it, and refuses over-cap without ever calling readFileToBuffer', async () => {
    runCommand.mockImplementation(async ({ cmd }: { cmd: string }) => {
      if (cmd === 'tar') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'stat') return { exitCode: 0, stdout: `${ENV_SNAPSHOT_MAX_BYTES + 1}`, stderr: '' };
      if (cmd === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const result = await snapshotEnvFilesystem('sandbox-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
    expect(readFileToBuffer).not.toHaveBeenCalled();
    // Cleanup still runs even on a size refusal.
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'rm' }));
  });

  it('uses a unique remote tar path per call', async () => {
    const seenPaths = new Set<string>();
    runCommand.mockImplementation(async ({ cmd, args }: { cmd: string; args: string[] }) => {
      if (cmd === 'tar') {
        seenPaths.add(args[1]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'stat') return { exitCode: 0, stdout: '10', stderr: '' };
      if (cmd === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected cmd ${cmd}`);
    });
    readFileToBuffer.mockResolvedValue(Buffer.from('x'));

    await snapshotEnvFilesystem('sandbox-1');
    await snapshotEnvFilesystem('sandbox-1');

    expect(seenPaths.size).toBe(2);
  });

  it('always attempts to delete the remote tarball, even when the tar command itself fails', async () => {
    runCommand.mockImplementation(async ({ cmd }: { cmd: string }) => {
      if (cmd === 'tar') return { exitCode: 1, stdout: '', stderr: 'sprite died' };
      if (cmd === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const result = await snapshotEnvFilesystem('sandbox-1');

    expect(result).toEqual({ ok: false, reason: 'tar_failed', detail: 'sprite died' });
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'rm' }));
  });

  it('maps a thrown exec error (a Sprite dying mid-tar) to a typed tar_failed refusal, never an unhandled throw', async () => {
    runCommand.mockImplementation(async ({ cmd }: { cmd: string }) => {
      if (cmd === 'tar') throw new Error('sandbox connection reset');
      if (cmd === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const result = await snapshotEnvFilesystem('sandbox-1');
    expect(result).toEqual({ ok: false, reason: 'tar_failed', detail: 'sandbox connection reset' });
  });
});
