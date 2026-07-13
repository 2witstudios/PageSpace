export interface DisplayedMachine {
  isKnownMachine: boolean;
  displayedMachineId: string | null;
}

/**
 * Two different questions, two different answers — conflating them is what
 * made an earlier version both kill live terminals AND never report a deleted
 * one. Shared by every Development surface's layout (drive-scoped and
 * global): the derivation only needs the fetched machine list and the URL's
 * selected id, neither of which differ between the two modes.
 *
 * "Does this machine still exist?" is answered by the LATEST fetch: a machine
 * that's gone must stop being shown, or "Machine not found" is unreachable.
 * "Which machines may stay mounted?" is answered elsewhere by the STICKY set
 * (see `useStickyMachineIds`), because a machine can drop out of a fetch
 * without being deleted (a swallowed per-page permission check) and
 * unmounting it would disconnect a running terminal.
 *
 * So a machine that vanishes stops being *displayed* immediately (this
 * function reports `displayedMachineId: null`), while its terminal stays warm
 * (hidden) until the LRU ages it out. A fetch blip therefore costs the user a
 * notice, never a dead session.
 */
export function resolveDisplayedMachine(
  machines: { id: string }[],
  selectedMachineId: string | null,
): DisplayedMachine {
  const isKnownMachine = selectedMachineId !== null && machines.some((machine) => machine.id === selectedMachineId);
  return {
    isKnownMachine,
    // What the host actually DISPLAYS — not merely what the URL selects. The
    // drain must gate on this same value: opening a session into a machine the
    // host is keeping hidden would mount an xterm inside a `display:none`
    // container, where `fit()` measures a zero-sized box and the PTY is created
    // at a bogus geometry — wrapping its output for the life of the session.
    displayedMachineId: isKnownMachine ? selectedMachineId : null,
  };
}
