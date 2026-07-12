import { describe, test, expect } from 'vitest';
import { parseSelectedMachineId } from '../development-route';

describe('parseSelectedMachineId', () => {
  test('reads the machine id out of the detail URL', () => {
    expect(parseSelectedMachineId('/dashboard/drive-1/development/machine-1', 'drive-1')).toBe('machine-1');
  });

  test('no machine is selected at the surface root', () => {
    expect(parseSelectedMachineId('/dashboard/drive-1/development', 'drive-1')).toBeNull();
    expect(parseSelectedMachineId('/dashboard/drive-1/development/', 'drive-1')).toBeNull();
  });

  test('ignores a path belonging to a different drive', () => {
    expect(parseSelectedMachineId('/dashboard/drive-2/development/machine-1', 'drive-1')).toBeNull();
  });

  test('takes only the machine segment, not what follows it', () => {
    expect(parseSelectedMachineId('/dashboard/drive-1/development/machine-1/extra', 'drive-1')).toBe('machine-1');
  });

  test('without a drive there is no machine', () => {
    expect(parseSelectedMachineId('/dashboard/development', undefined)).toBeNull();
  });
});
