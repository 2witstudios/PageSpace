import { describe, it, expect } from 'vitest';
import { siemDeliveryCursors } from '../monitoring';

/**
 * The SIEM worker uses the `id` column as the source key (e.g. 'activity_logs',
 * 'security_audit_log'). These tests are a structural sanity check that the
 * schema places no constraint on id values beyond uniqueness, so multiple
 * sources can coexist as independent cursor rows.
 */
describe('siem_delivery_cursors schema', () => {
  it('uses a text id column with no enum constraint', () => {
    expect(siemDeliveryCursors.id.dataType).toBe('string');
    expect(siemDeliveryCursors.id.enumValues).toBeUndefined();
  });

  it('makes id the primary key (one row per source)', () => {
    expect(siemDeliveryCursors.id.primary).toBe(true);
    expect(siemDeliveryCursors.id.notNull).toBe(true);
  });

  it('exposes the columns the worker reads and writes', () => {
    expect(siemDeliveryCursors.lastDeliveredId).toBeDefined();
    expect(siemDeliveryCursors.lastDeliveredAt).toBeDefined();
    expect(siemDeliveryCursors.lastError).toBeDefined();
    expect(siemDeliveryCursors.lastErrorAt).toBeDefined();
    expect(siemDeliveryCursors.deliveryCount).toBeDefined();
  });
});
