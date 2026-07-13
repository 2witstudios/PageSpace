import { describe, it, expect } from 'vitest';
import { createExecClientFromMachineHost } from '../machine-host-adapter';
import type { MachineHandle, MachineHost } from '../../machine-host';
import { SANDBOX_EGRESS_ALLOWLIST } from '../../execution-policy';

const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };
const substrate = { kind: 'sprite' as const };

function fakeHandle(over: Partial<MachineHandle> = {}): MachineHandle {
  return {
    machineId: 'm1',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    createCheckpoint: async () => {},
    stream: async () => {
      throw new Error('not used by this adapter');
    },
    listStreams: async () => [],
    killSession: async () => {},
    ...over,
  };
}

function makeHost(over: Partial<MachineHost> = {}): { host: MachineHost; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { provision: [], attach: [], kill: [] };
  const host: MachineHost = {
    provision: async (args) => {
      calls.provision.push(args);
      return fakeHandle();
    },
    attach: async (args) => {
      calls.attach.push(args);
      return fakeHandle();
    },
    kill: async (args) => {
      calls.kill.push(args);
    },
    ...over,
  };
  return { host, calls };
}

describe('createExecClientFromMachineHost', () => {
  it('given getOrCreate, should call host.provision with the given substrate and adapt the returned handle', async () => {
    const { host, calls } = makeHost();
    const client = createExecClientFromMachineHost(host, substrate);

    const handle = await client.getOrCreate({ name: 'k', options });
    expect(calls.provision).toEqual([{ name: 'k', substrate, options }]);
    expect(handle.sandboxId).toBe('m1');
  });

  it('given get on a live machine, should call host.attach and adapt the returned handle', async () => {
    const { host, calls } = makeHost();
    const client = createExecClientFromMachineHost(host, substrate);

    const handle = await client.get({ sandboxId: 'm1' });
    expect(calls.attach).toEqual([{ machineId: 'm1' }]);
    expect(handle?.sandboxId).toBe('m1');
  });

  it('given get on a vanished machine, should return null', async () => {
    const { host } = makeHost({ attach: async () => null });
    const client = createExecClientFromMachineHost(host, substrate);

    const handle = await client.get({ sandboxId: 'gone' });
    expect(handle).toBeNull();
  });

  it('given stop, should call host.kill with the machineId', async () => {
    const { host, calls } = makeHost();
    const client = createExecClientFromMachineHost(host, substrate);

    await client.stop({ sandboxId: 'm1' });
    expect(calls.kill).toEqual([{ machineId: 'm1' }]);
  });

  it('given the adapted handle, should delegate runCommand/writeFiles/readFileToBuffer to exec/writeFiles/readFile', async () => {
    const seen: { exec: unknown[]; writeFiles: unknown[]; readFile: unknown[] } = {
      exec: [],
      writeFiles: [],
      readFile: [],
    };
    const { host } = makeHost({
      provision: async () =>
        fakeHandle({
          exec: async (args) => {
            seen.exec.push(args);
            return { exitCode: 0, stdout: 'ok', stderr: '' };
          },
          writeFiles: async (files) => {
            seen.writeFiles.push(files);
          },
          readFile: async (args) => {
            seen.readFile.push(args);
            return Buffer.from('contents');
          },
        }),
    });
    const client = createExecClientFromMachineHost(host, substrate);
    const handle = await client.getOrCreate({ name: 'k', options });

    const result = await handle.runCommand({ cmd: 'echo', args: ['hi'] });
    await handle.writeFiles([{ path: '/a', content: 'x' }]);
    const buf = await handle.readFileToBuffer({ path: '/a' });

    expect(result.stdout).toBe('ok');
    expect(seen.exec).toEqual([{ cmd: 'echo', args: ['hi'] }]);
    expect(seen.writeFiles).toEqual([[{ path: '/a', content: 'x' }]]);
    expect(seen.readFile).toEqual([{ path: '/a' }]);
    expect(buf?.toString('utf8')).toBe('contents');
  });

  it('given the adapted handle, should delegate createCheckpoint to the underlying handle', async () => {
    const seen: Array<string> = [];
    const { host } = makeHost({
      provision: async () =>
        fakeHandle({
          createCheckpoint: async (comment) => {
            seen.push(comment);
          },
        }),
    });
    const client = createExecClientFromMachineHost(host, substrate);
    const handle = await client.getOrCreate({ name: 'k', options });

    await handle.createCheckpoint('pagespace-pre-agent-turn-1');
    expect(seen).toEqual(['pagespace-pre-agent-turn-1']);
  });
});
