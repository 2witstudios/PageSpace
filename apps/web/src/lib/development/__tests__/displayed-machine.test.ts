import { describe, test, expect } from 'vitest';
import { resolveDisplayedMachine } from '../displayed-machine';

const machine = (id: string) => ({ id });

describe('resolveDisplayedMachine', () => {
  test('a known machine is displayed', () => {
    expect(resolveDisplayedMachine([machine('m-1')], 'm-1')).toEqual({
      isKnownMachine: true,
      displayedMachineId: 'm-1',
    });
  });

  test('no machine is selected at the surface root', () => {
    expect(resolveDisplayedMachine([machine('m-1')], null)).toEqual({
      isKnownMachine: false,
      displayedMachineId: null,
    });
  });

  test('a machine missing from the latest fetch is not displayed, even mid-selection', () => {
    // Distinct from "not known": the URL still names it, but the fetch says
    // it's gone (deleted, or a swallowed permission-check blip) — the caller
    // must stop DISPLAYING it without that meaning "evict its terminal".
    expect(resolveDisplayedMachine([machine('m-2')], 'm-1')).toEqual({
      isKnownMachine: false,
      displayedMachineId: null,
    });
  });

  test('an empty machine list never displays anything', () => {
    expect(resolveDisplayedMachine([], 'm-1')).toEqual({
      isKnownMachine: false,
      displayedMachineId: null,
    });
  });
});
