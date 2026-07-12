import { create } from 'zustand';

export type MachineTabValue = 'terminal' | 'code' | 'diff' | 'settings';

export const DEFAULT_MACHINE_TAB: MachineTabValue = 'terminal';

/**
 * Which tab each Machine is showing, keyed by machine id.
 *
 * The Machine page's tabs used to be uncontrolled (`defaultValue="terminal"`),
 * which made the active tab unreachable from anywhere else — and that quietly
 * broke the Development surface: `MachineWorkspace` (the thing that creates a
 * machine's workspace) only mounts inside the Terminal tab, so clicking a
 * session for a machine parked on Code/Diff/Settings had nowhere to land. The
 * click did nothing at all.
 *
 * Hoisting the value here makes "show me this machine's terminal" something a
 * caller can actually ask for, without any other change to how the tabs behave:
 * a machine with no entry shows Terminal, exactly as before.
 */
interface MachineTabStoreState {
  tabs: Record<string, MachineTabValue>;
  setTab: (machineId: string, tab: MachineTabValue) => void;
  /** Bring a machine's Terminal tab to the front — used when opening a session on it. */
  focusTerminal: (machineId: string) => void;
}

export const useMachineTabStore = create<MachineTabStoreState>((set) => ({
  tabs: {},
  setTab: (machineId, tab) =>
    set((state) => (state.tabs[machineId] === tab ? state : { tabs: { ...state.tabs, [machineId]: tab } })),
  focusTerminal: (machineId) =>
    set((state) =>
      // An unset machine is ALREADY showing Terminal (that's the default), so
      // this must not write an entry for it — that would be a state change, and
      // a re-render of every MachineView, for no visible difference.
      (state.tabs[machineId] ?? DEFAULT_MACHINE_TAB) === DEFAULT_MACHINE_TAB
        ? state
        : { tabs: { ...state.tabs, [machineId]: DEFAULT_MACHINE_TAB } },
    ),
}));
