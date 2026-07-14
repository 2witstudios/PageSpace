import { describe, test, expect, beforeEach } from 'vitest';
import { useMachineTabStore, DEFAULT_MACHINE_TAB } from '../useMachineTabStore';

beforeEach(() => {
  useMachineTabStore.setState({ tabs: {} });
});

const tabOf = (machineId: string) => useMachineTabStore.getState().tabs[machineId] ?? DEFAULT_MACHINE_TAB;

describe('useMachineTabStore', () => {
  test('a machine with no stored tab shows Terminal', () => {
    // MachineView's previous uncontrolled default, preserved.
    expect(tabOf('machine-1')).toBe('terminal');
  });

  test('remembers each machine\'s tab independently', () => {
    useMachineTabStore.getState().setTab('machine-1', 'diff');

    expect(tabOf('machine-1')).toBe('diff');
    expect(tabOf('machine-2')).toBe('terminal');
  });

  test('focusTerminal brings a machine parked on another tab back to Terminal', () => {
    // The reason this store exists: only the Terminal tab mounts a machine's
    // workspace, so a session clicked on a machine sitting on Code/Diff/Settings
    // had nowhere to land and the click did nothing at all.
    useMachineTabStore.getState().setTab('machine-1', 'code');

    useMachineTabStore.getState().focusTerminal('machine-1');

    expect(tabOf('machine-1')).toBe('terminal');
  });

  test('no-op writes keep state identity, so they cannot re-render subscribers', () => {
    useMachineTabStore.getState().setTab('machine-1', 'code');
    const before = useMachineTabStore.getState().tabs;

    useMachineTabStore.getState().setTab('machine-1', 'code');

    expect(useMachineTabStore.getState().tabs).toBe(before);
  });

  test('focusTerminal on a machine already showing Terminal is a no-op', () => {
    const before = useMachineTabStore.getState().tabs;

    useMachineTabStore.getState().focusTerminal('machine-1');

    expect(useMachineTabStore.getState().tabs).toBe(before);
  });
});
