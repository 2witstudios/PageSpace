/**
 * The Stripe seat adapter passes the service's idempotency key to Stripe untouched and sends the
 * proration the service chose (raise: create_prorations, release: none). Test mode only: the
 * prices live in config, and this module names none.
 */
import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@/lib/stripe', () => ({ stripe: {} }));

import { stripeSeatBilling } from '../seat-billing';

function fakeClient() {
  const update = vi.fn(async (_id: string, params: { quantity: number }) => ({ quantity: params.quantity }));
  const retrieve = vi.fn(async () => ({ quantity: 3 }));
  return { client: { subscriptionItems: { update, retrieve } } as unknown as Stripe, update, retrieve };
}

describe('stripeSeatBilling', () => {
  it('SEAT-4 (partial) a raise is one subscriptionItems.update with the quantity, the proration and the service\'s idempotency key', async () => {
    const { client, update } = fakeClient();
    const result = await stripeSeatBilling(client).setSeatQuantity({ itemId: 'si_1', quantity: 2, prorationBehavior: 'create_prorations' }, 'pagespace-org:o1:seat-quantity.update:abc');
    expect(result).toEqual({ quantity: 2 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('si_1', { quantity: 2, proration_behavior: 'create_prorations' }, { idempotencyKey: 'pagespace-org:o1:seat-quantity.update:abc' });
  });

  it('SEAT-5 (partial) a release sends proration none; the quantity read comes from the item', async () => {
    const { client, update, retrieve } = fakeClient();
    const port = stripeSeatBilling(client);
    await port.setSeatQuantity({ itemId: 'si_1', quantity: 0, prorationBehavior: 'none' }, 'k');
    expect(update).toHaveBeenCalledWith('si_1', { quantity: 0, proration_behavior: 'none' }, { idempotencyKey: 'k' });
    expect(await port.readSeatQuantity('si_1')).toBe(3);
    expect(retrieve).toHaveBeenCalledWith('si_1');
  });
});
