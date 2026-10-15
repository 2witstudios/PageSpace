import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
function succeeds(machine: unknown) {
  return spawnSync('jq', ['-e', '-f', resolve('fly-migration-succeeded.jq')], { input: JSON.stringify(machine), encoding: 'utf8' }).status === 0;
}
const exit = { exited_at: '2026-10-12T00:00:00Z', exit_code: 0, guest_exit_code: 0 };
const machine = (event: unknown) => ({ state: 'stopped', events: [{ type: 'exit', timestamp: 2, request: { exit_event: event } }] });
describe('Fly migration completion evidence', () => {
  it('requires a successful exit event, not just stopped state', () => {
    expect(succeeds(machine(exit))).toBe(true);
    expect(succeeds({ state: 'stopped', events: [] })).toBe(false);
    expect(succeeds(machine({ ...exit, guest_exit_code: 1 }))).toBe(false);
    expect(succeeds(machine({ ...exit, exit_code: 1 }))).toBe(false);
    expect(succeeds(machine({ ...exit, oom_killed: true }))).toBe(false);
    expect(succeeds(machine({ ...exit, requested_stop: true }))).toBe(false);
  });
  it('understands Fly MonitorEvent and zero fields omitted by the Go API', () => {
    expect(succeeds({ state: 'stopped', events: [{ type: 'exit', timestamp: 2, request: { MonitorEvent: { exit_event: { exited_at: exit.exited_at } } } }] })).toBe(true);
  });
});

describe('Fly normal exit signals regression', () => {
  it('accepts the successful production exit from machine 83d593c7662698', () => {
    const productionExit = {
      exited_at: '2026-10-15T18:40:30.498Z', exit_code: 0, guest_exit_code: 0,
      signal: -1, guest_signal: -1, oom_killed: false, requested_stop: false,
    };
    expect(succeeds(machine(productionExit))).toBe(true);
    expect(succeeds({ state: 'stopped', events: [{ type: 'exit', timestamp: 2,
      request: { MonitorEvent: { exit_event: productionExit } } }] })).toBe(true);
  });
  it.each(['signal', 'guest_signal'])('rejects positive %s even with zero exit codes', field => {
    expect(succeeds(machine({ ...exit, [field]: 15 }))).toBe(false);
  });
  it('rejects incomplete evidence and uses the latest exit', () => {
    expect(succeeds(machine({}))).toBe(false);
    expect(succeeds({ state: 'started', events: machine(exit).events })).toBe(false);
    expect(succeeds({ state: 'stopped', events: [
      ...machine(exit).events,
      { type: 'exit', timestamp: 3, request: { exit_event: { ...exit, exit_code: 1 } } },
    ] })).toBe(false);
  });
});

function fails(machine: unknown) {
  return spawnSync('jq', ['-e', '--arg', 'mode', 'failed', '-f', resolve('fly-migration-succeeded.jq')], { input: JSON.stringify(machine), encoding: 'utf8' }).status === 0;
}
describe('definite failure versus delayed evidence', () => {
  it('keeps missing evidence pending, but rejects definite failures promptly', () => {
    expect(fails({ state: 'stopped', events: [] })).toBe(false);
    expect(fails(machine({ ...exit, signal: -1, guest_signal: -1 }))).toBe(false);
    for (const failure of [{ exit_code: 1 }, { guest_exit_code: 2 }, { signal: 15 }, { guest_signal: 9 }, { oom_killed: true }, { requested_stop: true }]) {
      expect(fails(machine({ ...exit, ...failure }))).toBe(true);
    }
  });
});
