import { describe, it, expect } from 'vitest';
import { commandDriveIdFor } from '../command-scope';

describe('commandDriveIdFor', () => {
  it("prefers the selected agent's own drive over wherever the user is standing", () => {
    // The regression this exists for: an agent borrowed into another drive
    // still has its chips resolved against its own page.driveId server-side,
    // so scoping to the route offers commands that fail as not_found.
    expect(commandDriveIdFor({ driveId: 'agent-drive' }, 'route-drive')).toBe('agent-drive');
  });

  it("uses the agent's drive even when the route resolves to no drive at all", () => {
    expect(commandDriveIdFor({ driveId: 'agent-drive' }, undefined)).toBe('agent-drive');
    expect(commandDriveIdFor({ driveId: 'agent-drive' }, null)).toBe('agent-drive');
  });

  it('falls back to the location drive in assistant mode, which is what that turn scopes to', () => {
    expect(commandDriveIdFor(null, 'route-drive')).toBe('route-drive');
    expect(commandDriveIdFor(undefined, 'route-drive')).toBe('route-drive');
  });

  it('normalises "no drive" to undefined, the shape the composer prop expects', () => {
    expect(commandDriveIdFor(null, null)).toBeUndefined();
    expect(commandDriveIdFor(undefined, undefined)).toBeUndefined();
  });
});
