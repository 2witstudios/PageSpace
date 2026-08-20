import { describe, expect, it } from 'vitest';
import { contentRefLockId, CONTENT_REF_LOCK_CLASS } from '../page-content-lock';

const ref = (prefix: string) => prefix.padEnd(64, '0');

describe('contentRefLockId', () => {
  it('given the same ref, always produces the same id', () => {
    expect(contentRefLockId(ref('deadbeef'))).toBe(contentRefLockId(ref('deadbeef')));
  });

  it('given different refs, produces different ids', () => {
    expect(contentRefLockId(ref('deadbeef'))).not.toBe(contentRefLockId(ref('feedface')));
  });

  it('stays inside the signed 4-byte range Postgres accepts', () => {
    for (const prefix of ['00000000', 'ffffffff', '7fffffff', '80000000', 'a1b2c3d4']) {
      const id = contentRefLockId(ref(prefix));
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(id).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  it('maps the top of the unsigned range to a negative id rather than overflowing', () => {
    expect(contentRefLockId(ref('ffffffff'))).toBe(-1);
    expect(contentRefLockId(ref('80000000'))).toBe(-2147483648);
    expect(contentRefLockId(ref('7fffffff'))).toBe(2147483647);
  });

  it('reads only the leading 32 bits, so the rest of the hash cannot change the id', () => {
    expect(contentRefLockId('deadbeef' + 'a'.repeat(56))).toBe(
      contentRefLockId('deadbeef' + 'b'.repeat(56))
    );
  });

  it('namespaces the class so these locks cannot collide with single-argument keys', () => {
    expect(CONTENT_REF_LOCK_CLASS).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(CONTENT_REF_LOCK_CLASS).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});
