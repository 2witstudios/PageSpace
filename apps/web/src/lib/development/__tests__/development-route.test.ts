import { describe, test, expect } from 'vitest';
import { parseSelectedMachineId, buildMachineHref } from '../development-route';

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

  test('without a drive there is no machine at the surface root', () => {
    expect(parseSelectedMachineId('/dashboard/development', undefined)).toBeNull();
  });

  test('reads the machine id out of the GLOBAL (driveless) detail URL', () => {
    expect(parseSelectedMachineId('/dashboard/development/machine-1', undefined)).toBe('machine-1');
  });

  test('a drive-scoped path is not mistaken for the global one', () => {
    expect(parseSelectedMachineId('/dashboard/drive-1/development/machine-1', undefined)).toBeNull();
  });
});

describe('buildMachineHref', () => {
  test('builds a drive-scoped machine href', () => {
    expect(buildMachineHref('drive-1', 'machine-1')).toBe('/dashboard/drive-1/development/machine-1');
  });

  test('builds a GLOBAL machine href, never embedding the drive', () => {
    expect(buildMachineHref(undefined, 'machine-1')).toBe('/dashboard/development/machine-1');
  });

  test('round-trips with parseSelectedMachineId for every driveId', () => {
    for (const driveId of ['drive-1', undefined]) {
      const href = buildMachineHref(driveId, 'machine-1');
      expect(parseSelectedMachineId(href, driveId)).toBe('machine-1');
    }
  });
});
