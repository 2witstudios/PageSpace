import { describe, it, expect } from 'vitest';

import * as auditModule from '../index';

describe('legacy audit adapter removal', () => {
  it('does not export auditAuthEvent from the audit module', () => {
    expect('auditAuthEvent' in auditModule).toBe(false);
  });

  it('does not export auditSecurityEvent from the audit module', () => {
    expect('auditSecurityEvent' in auditModule).toBe(false);
  });
});
