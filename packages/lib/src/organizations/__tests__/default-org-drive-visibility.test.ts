import { describe, it, expect } from 'vitest';
import { defaultOrgDriveVisibility } from '../policies-core';

describe('defaultOrgDriveVisibility', () => {
  it('POL-6 (partial): under an Edit floor a new or moved-in drive starts Restricted (it has no Edit default role yet)', () => {
    expect(defaultOrgDriveVisibility('edit')).toBe('RESTRICTED');
  });

  it('DRV-4 (partial): under a View floor new org drives default to Open', () => {
    expect(defaultOrgDriveVisibility('view')).toBe('OPEN');
  });
});
