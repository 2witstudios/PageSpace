/**
 * An in-memory Stripe for the org-billing shell, faithful to the three behaviours the
 * shell's guarantees rest on:
 *
 *   - IDEMPOTENCY: a write with a key already seen returns the first result without
 *     creating anything; the same key with different parameters is refused, as Stripe
 *     refuses it. `expireIdempotencyKeys()` models Stripe's 24-hour key window passing.
 *   - SEARCH LAG: customer search is eventually consistent in Stripe; `searchLag` hides
 *     customers from search until `indexSearch()` runs.
 *   - LOST RESPONSES: `loseNextResponse(op)` lets Stripe EXECUTE the write and then
 *     throws a connection error, as a timeout after the request landed would.
 *
 * Every write is counted, so a test can assert that a replay created nothing.
 */
import type { OrgBillingStripe, OrgStripeSubscription } from '../org-subscription';
import type { OrgBusinessSubscriptionParams, OrgCustomerParams } from '@pagespace/lib/billing/org-subscription-core';

type WriteOp = 'createCustomer' | 'createSubscription' | 'createSubscriptionItem' | 'updateSubscriptionItemQuantity' | 'cancelSubscription';

interface Customer {
  id: string;
  params: OrgCustomerParams;
  created: number;
}

export class FakeOrgStripe implements OrgBillingStripe {
  customers = new Map<string, Customer>();
  subscriptions = new Map<string, OrgStripeSubscription>();
  writes: Record<WriteOp, number> = {
    createCustomer: 0,
    createSubscription: 0,
    createSubscriptionItem: 0,
    updateSubscriptionItemQuantity: 0,
    cancelSubscription: 0,
  };
  reads = { findCustomerByOrgId: 0, listCustomerSubscriptions: 0 };
  /** Every idempotency key a write was sent with, in order. */
  keysSeen: string[] = [];
  searchLag = false;
  /** Delay inside each write, to widen any race between concurrent callers. */
  writeDelayMs = 0;

  private idempotent = new Map<string, { params: string; result: unknown }>();
  private searchable = new Set<string>();
  private lose = new Set<WriteOp>();
  private fail = new Map<WriteOp, Error>();
  private seq = 0;
  /** Ids are unique across fakes: organizations.stripeCustomerId is unique in the shared database. */
  private readonly run = Math.random().toString(36).slice(2, 10);
  private clock = 1_800_000_000;

  loseNextResponse(op: WriteOp): void {
    this.lose.add(op);
  }

  failNext(op: WriteOp, error: Error): void {
    this.fail.set(op, error);
  }

  expireIdempotencyKeys(): void {
    this.idempotent.clear();
  }

  indexSearch(): void {
    for (const id of this.customers.keys()) this.searchable.add(id);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_fake${this.run}_${this.seq}`;
  }

  private async write<T>(op: WriteOp, key: string, params: unknown, run: () => T): Promise<T> {
    this.keysSeen.push(key);
    if (this.writeDelayMs > 0) await new Promise((r) => setTimeout(r, this.writeDelayMs));
    const failure = this.fail.get(op);
    if (failure) {
      this.fail.delete(op);
      throw failure;
    }
    const serialized = JSON.stringify(params);
    const prior = this.idempotent.get(key);
    if (prior) {
      if (prior.params !== serialized) {
        throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters they were first used with.'), {
          type: 'StripeIdempotencyError',
        });
      }
      return prior.result as T;
    }
    this.writes[op] += 1;
    const result = run();
    this.idempotent.set(key, { params: serialized, result });
    if (this.lose.has(op)) {
      this.lose.delete(op);
      throw Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });
    }
    return result;
  }

  async createCustomer(params: OrgCustomerParams, idempotencyKey: string): Promise<{ id: string }> {
    return this.write('createCustomer', idempotencyKey, params, () => {
      const id = this.nextId('cus');
      this.customers.set(id, { id, params, created: (this.clock += 1) });
      if (!this.searchLag) this.searchable.add(id);
      return { id };
    });
  }

  async findCustomerByOrgId(orgId: string): Promise<string | null> {
    this.reads.findCustomerByOrgId += 1;
    const found = [...this.customers.values()]
      .filter((c) => this.searchable.has(c.id) && c.params.metadata.pagespace_org_id === orgId)
      .sort((a, b) => a.created - b.created);
    return found[0]?.id ?? null;
  }

  async createSubscription(params: OrgBusinessSubscriptionParams, idempotencyKey: string): Promise<OrgStripeSubscription> {
    return this.write('createSubscription', idempotencyKey, params, () => {
      if (!this.customers.has(params.customer)) throw new Error(`No such customer: '${params.customer}'`);
      const created = (this.clock += 1);
      const trialing = typeof params.trial_period_days === 'number' && params.trial_period_days > 0;
      const sub: OrgStripeSubscription = {
        id: this.nextId('sub'),
        customerId: params.customer,
        status: trialing ? 'trialing' : 'incomplete',
        created,
        metadata: { ...params.metadata },
        items: params.items.map((item) => ({ id: this.nextId('si'), priceId: item.price, quantity: item.quantity })),
        trialEnd: trialing ? created + (params.trial_period_days ?? 0) * 86_400 : null,
        currentPeriodStart: created,
        currentPeriodEnd: created + 30 * 86_400,
        cancelAtPeriodEnd: false,
      };
      this.subscriptions.set(sub.id, sub);
      return structuredClone(sub);
    });
  }

  async listCustomerSubscriptions(customerId: string): Promise<OrgStripeSubscription[]> {
    this.reads.listCustomerSubscriptions += 1;
    return [...this.subscriptions.values()].filter((s) => s.customerId === customerId).map((s) => structuredClone(s));
  }

  async createSubscriptionItem(
    params: { subscriptionId: string; priceId: string; quantity: number },
    idempotencyKey: string,
  ): Promise<{ id: string; quantity: number }> {
    return this.write('createSubscriptionItem', idempotencyKey, params, () => {
      const sub = this.subscriptions.get(params.subscriptionId);
      if (!sub) throw new Error(`No such subscription: '${params.subscriptionId}'`);
      const item = { id: this.nextId('si'), priceId: params.priceId, quantity: params.quantity };
      sub.items = [...sub.items, item];
      return { id: item.id, quantity: item.quantity };
    });
  }

  async updateSubscriptionItemQuantity(
    params: { itemId: string; quantity: number; prorationBehavior: 'create_prorations' | 'none' },
    idempotencyKey: string,
  ): Promise<{ id: string; quantity: number }> {
    return this.write('updateSubscriptionItemQuantity', idempotencyKey, params, () => {
      for (const sub of this.subscriptions.values()) {
        const item = sub.items.find((i) => i.id === params.itemId);
        if (item) {
          sub.items = sub.items.map((i) => (i.id === params.itemId ? { ...i, quantity: params.quantity } : i));
          return { id: params.itemId, quantity: params.quantity };
        }
      }
      throw new Error(`No such subscription item: '${params.itemId}'`);
    });
  }

  async cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<{ status: string }> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`No such subscription: '${subscriptionId}'`);
    // Stripe refuses to cancel what is already over; the shell must not ask.
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return { status: sub.status };
    return this.write('cancelSubscription', idempotencyKey, { subscriptionId }, () => {
      sub.status = 'canceled';
      return { status: sub.status };
    });
  }

  /** Test helper: the seat item quantity Stripe holds for a subscription. */
  seatQuantity(subscriptionId: string, seatPriceId: string): number | undefined {
    return this.subscriptions.get(subscriptionId)?.items.find((i) => i.priceId === seatPriceId)?.quantity;
  }
}
