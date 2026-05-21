import { describe, it, expect } from 'vitest';
import * as serverOnly from './server-only-stub';

describe('server-only-stub', () => {
  it('given import of server-only stub, should have no named exports (matches real server-only shape)', () => {
    const exportedKeys = Object.keys(serverOnly).filter((k) => k !== '__esModule');
    expect(exportedKeys).toHaveLength(0);
  });
});
