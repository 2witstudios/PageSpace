/**
 * The blue/green swap, with Fly mocked.
 *
 * ONE PROPERTY IS UNDER TEST EVERYWHERE HERE: the old machine survives every
 * failure. Each case therefore asserts on the CALL LOG rather than only on the
 * return value — "the deploy reported failure" is not evidence that the old machine
 * is still serving, and the log is where a stray `delete:old` would show up.
 */
import { describe, it, expect } from 'vitest';
import {
  deployBlueGreen,
  DEFAULT_HEALTH_COMMAND,
  type DeployerFlaps,
  type DeployResult,
} from '../deployer';
import type { MachineConfig } from '../../fly/flaps-client';

const CONFIG: MachineConfig = { image: 'registry.fly.io/pgs-app-a@sha256:x' };

interface Harness {
  flaps: DeployerFlaps;
  log: string[];
  promotedWith: string[];
}

function harness(
  overrides: {
    create?: () => Promise<{ id: string }>;
    wait?: () => Promise<void>;
    exec?: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    deleteMachine?: (machineId: string) => Promise<void>;
  } = {},
): Harness {
  const log: string[] = [];
  const promotedWith: string[] = [];
  return {
    log,
    promotedWith,
    flaps: {
      createMachine: async () => {
        log.push('create:new');
        return overrides.create ? await overrides.create() : { id: 'm-new' };
      },
      waitForState: async () => {
        log.push('wait:started');
        if (overrides.wait) await overrides.wait();
      },
      exec: async (_id, command) => {
        log.push(`exec:${command.length}`);
        return overrides.exec
          ? await overrides.exec()
          : { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      deleteMachine: async (machineId) => {
        log.push(`delete:${machineId}`);
        if (overrides.deleteMachine) await overrides.deleteMachine(machineId);
      },
    },
  };
}

function deploy(
  h: Harness,
  {
    oldMachineId = 'm-old',
    promote = async (id: string) => {
      h.promotedWith.push(id);
      h.log.push('promote');
      return true;
    },
  }: { oldMachineId?: string | null; promote?: (id: string) => Promise<boolean> } = {},
): Promise<DeployResult> {
  return deployBlueGreen({
    flaps: h.flaps,
    machineName: 'srv-abc',
    config: CONFIG,
    oldMachineId,
    promote,
  });
}

describe('a healthy deploy', () => {
  const h = harness();
  const resultPromise = deploy(h);

  it('runs create → wait → health → promote → destroy old, in that order', async () => {
    await resultPromise;
    expect(h.log).toEqual(['create:new', 'wait:started', `exec:${DEFAULT_HEALTH_COMMAND.length}`, 'promote', 'delete:m-old']);
  });

  it('promotes the NEW machine id before the old one is destroyed', async () => {
    await resultPromise;
    expect(h.promotedWith).toEqual(['m-new']);
    expect(h.log.indexOf('promote')).toBeLessThan(h.log.indexOf('delete:m-old'));
  });

  it('reports success with the new machine', async () => {
    expect(await resultPromise).toEqual({
      ok: true,
      machineId: 'm-new',
      oldMachineDestroyed: true,
    });
  });
});

describe('the first deploy, with no old machine', () => {
  const h = harness();

  it('destroys nothing', async () => {
    const result = await deploy(h, { oldMachineId: null });
    expect(result).toEqual({ ok: true, machineId: 'm-new', oldMachineDestroyed: true });
    expect(h.log.some((entry) => entry.startsWith('delete:'))).toBe(false);
  });
});

describe('the machine never starts', () => {
  const h = harness({
    wait: async () => {
      throw new Error('timed out waiting for started');
    },
  });

  it('destroys the NEW machine and leaves the old one serving', async () => {
    const result = await deploy(h);
    expect(result).toEqual({
      ok: false,
      stage: 'wait',
      error: 'timed out waiting for started',
      rolledBack: true,
    });
    expect(h.log).toEqual(['create:new', 'wait:started', 'delete:m-new']);
  });
});

describe('the machine starts but the app does not serve', () => {
  const h = harness({
    exec: async () => ({ exitCode: 1, stdout: '', stderr: 'connection refused' }),
  });

  it('refuses the promotion — started is not serving', async () => {
    const result = await deploy(h);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe('health');
    expect(result.ok === false && result.error).toContain('connection refused');
    expect(h.log).toEqual([
      'create:new',
      'wait:started',
      `exec:${DEFAULT_HEALTH_COMMAND.length}`,
      'delete:m-new',
    ]);
  });
});

describe('the exec call itself fails', () => {
  const h = harness({
    exec: async () => {
      throw new Error('flaps 500');
    },
  });

  it('fails closed — an unanswerable health check is a failed one', async () => {
    const result = await deploy(h);
    expect(result.ok === false && result.stage).toBe('health');
    expect(h.log).toContain('delete:m-new');
    expect(h.log).not.toContain('delete:m-old');
  });
});

describe('the database refuses the promotion', () => {
  const h = harness();

  it('rolls back rather than destroying the old machine anyway', async () => {
    const result = await deploy(h, { promote: async () => false });
    expect(result).toEqual({
      ok: false,
      stage: 'promote',
      error: 'The published app row refused to record the new machine',
      rolledBack: true,
    });
    expect(h.log).toEqual([
      'create:new',
      'wait:started',
      `exec:${DEFAULT_HEALTH_COMMAND.length}`,
      'delete:m-new',
    ]);
  });
});

describe('the promotion throws', () => {
  const h = harness();

  it('rolls back', async () => {
    const result = await deploy(h, {
      promote: async () => {
        throw new Error('deadlock detected');
      },
    });
    expect(result).toEqual({
      ok: false,
      stage: 'promote',
      error: 'deadlock detected',
      rolledBack: true,
    });
    expect(h.log).not.toContain('delete:m-old');
  });
});

describe('the create fails', () => {
  const h = harness({
    create: async () => {
      throw new Error('rate limited');
    },
  });

  it('has nothing to roll back and never touches the old machine', async () => {
    const result = await deploy(h);
    expect(result).toEqual({
      ok: false,
      stage: 'create',
      error: 'rate limited',
      rolledBack: true,
    });
    expect(h.log).toEqual(['create:new']);
  });
});

describe('Fly returns a machine with no id', () => {
  const h = harness({ create: async () => ({ id: '' }) });

  it('reports an un-rolled-back create rather than deploying an unnameable machine', async () => {
    const result = await deploy(h);
    expect(result).toEqual({
      ok: false,
      stage: 'create',
      error: 'Fly returned a machine with no id',
      rolledBack: false,
    });
    expect(h.log).toEqual(['create:new']);
  });
});

describe('the rollback itself fails', () => {
  const h = harness({
    exec: async () => ({ exitCode: 7, stdout: '', stderr: 'boom' }),
    deleteMachine: async () => {
      throw new Error('flaps unavailable');
    },
  });

  it('reports the orphan without losing the original reason', async () => {
    const result = await deploy(h);
    expect(result.ok === false && result.stage).toBe('health');
    expect(result.ok === false && result.rolledBack).toBe(false);
    expect(result.ok === false && result.rollbackError).toBe('flaps unavailable');
    expect(result.ok === false && result.error).toContain('exited 7');
  });
});

describe('the old machine cannot be destroyed after a successful swap', () => {
  const h = harness({
    deleteMachine: async (machineId) => {
      if (machineId === 'm-old') throw new Error('machine is leased');
    },
  });

  it('is still a SUCCESSFUL deploy — the app is live and recorded', async () => {
    const result = await deploy(h);
    expect(result).toEqual({
      ok: true,
      machineId: 'm-new',
      oldMachineDestroyed: false,
      oldMachineError: 'machine is leased',
    });
  });
});

describe('a redeploy that resolves to the same machine', () => {
  const h = harness();

  it('does not destroy the machine it just promoted (a name-keyed create is idempotent)', async () => {
    const result = await deploy(h, { oldMachineId: 'm-new' });
    expect(result).toEqual({ ok: true, machineId: 'm-new', oldMachineDestroyed: true });
    expect(h.log.filter((entry) => entry.startsWith('delete:'))).toEqual([]);
  });
});
