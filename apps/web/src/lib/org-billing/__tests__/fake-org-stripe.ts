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
 *   - IN-FLIGHT KEYS: a second request with a key whose first request is still running is
 *     refused, as Stripe refuses it ("another request with this key is in progress").
 *
 * Every write is counted, so a test can assert that a replay created nothing.
 *
 * INVOICES: a subscription is created `incomplete` with an OPEN first invoice carrying a
 * confirmation secret, as Stripe does under `default_incomplete`; `payLatestInvoice`
 * stands in for the client confirming a card with that secret.
 */
import type { OrgBillingStripe, OrgInvoiceSummary, OrgStripeSubscription } from '../org-subscription';
import type {
  OrgBusinessSubscriptionParams,
  OrgCustomerCreateParams,
  OrgCustomerDetails,
  OrgLatestInvoice,
} from '@pagespace/lib/billing/org-subscription-core';

interface FakeInvoice {
  id: string;
  customerId: string;
  subscriptionId: string;
  status: 'open' | 'paid';
  amountDueCents: number;
  amountPaidCents: number;
  clientSecret: string;
  created: number;
}

/** The fake's list prices, minor units: the test Business base and extra seat. */
const FAKE_BASE_CENTS = 5000;
const FAKE_SEAT_CENTS = 1000;

type WriteOp =
  | 'createCustomer'
  | 'updateCustomer'
  | 'createSubscription'
  | 'createSubscriptionItem'
  | 'updateSubscriptionItemQuantity'
  | 'cancelSubscription';

interface Customer {
  id: string;
  params: OrgCustomerCreateParams;
  details: OrgCustomerDetails | null;
  created: number;
}

export class FakeOrgStripe implements OrgBillingStripe {
  customers = new Map<string, Customer>();
  subscriptions = new Map<string, OrgStripeSubscription>();
  writes: Record<WriteOp, number> = {
    createCustomer: 0,
    updateCustomer: 0,
    createSubscription: 0,
    createSubscriptionItem: 0,
    updateSubscriptionItemQuantity: 0,
    cancelSubscription: 0,
  };
  reads = { findCustomerByOrgId: 0, listCustomerSubscriptions: 0, retrieveSubscription: 0, latestInvoice: 0 };
  /** Each subscription's invoices, newest last. */
  invoices = new Map<string, FakeInvoice[]>();
  portalSessions: Array<{ customerId: string; returnUrl: string }> = [];
  invoiceListCalls: Array<{ customerId: string; limit: number; startingAfter: string | undefined }> = [];
  /** Every idempotency key a write was sent with, in order. */
  keysSeen: string[] = [];
  searchLag = false;
  /** Delay inside each write, to widen any race between concurrent callers. */
  writeDelayMs = 0;

  private idempotent = new Map<string, { params: string; result: unknown }>();
  private inFlight = new Set<string>();
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
    if (this.inFlight.has(key)) {
      throw Object.assign(new Error('There is currently another in-progress request using this Idempotent Key.'), {
        type: 'StripeIdempotencyError',
      });
    }
    this.inFlight.add(key);
    try {
      return await this.execute(op, key, params, run);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async execute<T>(op: WriteOp, key: string, params: unknown, run: () => T): Promise<T> {
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

  async createCustomer(params: OrgCustomerCreateParams, idempotencyKey: string): Promise<{ id: string }> {
    return this.write('createCustomer', idempotencyKey, params, () => {
      const id = this.nextId('cus');
      this.customers.set(id, { id, params, details: null, created: (this.clock += 1) });
      if (!this.searchLag) this.searchable.add(id);
      return { id };
    });
  }

  async updateCustomer(customerId: string, details: OrgCustomerDetails, idempotencyKey: string): Promise<void> {
    await this.write('updateCustomer', idempotencyKey, { customerId, details }, () => {
      const customer = this.customers.get(customerId);
      if (!customer) throw new Error(`No such customer: '${customerId}'`);
      customer.details = { ...details };
      return null;
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<OrgStripeSubscription> {
    this.reads.retrieveSubscription += 1;
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`No such subscription: '${subscriptionId}'`);
    return structuredClone(sub);
  }

  /** Test helper: end a subscription in Stripe (a cardless trial ending, an expired incomplete). */
  endSubscription(subscriptionId: string, status: 'canceled' | 'incomplete_expired' = 'canceled'): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) sub.status = status;
  }

  /** Test helper: live subscriptions Stripe holds for this customer. */
  liveSubscriptions(customerId: string): OrgStripeSubscription[] {
    return [...this.subscriptions.values()].filter(
      (s) => s.customerId === customerId && s.status !== 'canceled' && s.status !== 'incomplete_expired',
    );
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
      // default_incomplete: the first invoice waits for the client's card.
      const sub: OrgStripeSubscription = {
        id: this.nextId('sub'),
        customerId: params.customer,
        status: 'incomplete',
        created,
        metadata: { ...params.metadata },
        items: params.items.map((item) => ({ id: this.nextId('si'), priceId: item.price, quantity: item.quantity })),
        trialEnd: null,
        currentPeriodStart: created,
        currentPeriodEnd: created + 30 * 86_400,
        cancelAtPeriodEnd: false,
      };
      this.subscriptions.set(sub.id, sub);
      const extra = params.items[1].quantity;
      this.addInvoice(sub, FAKE_BASE_CENTS + FAKE_SEAT_CENTS * extra);
      return structuredClone(sub);
    });
  }

  private addInvoice(sub: OrgStripeSubscription, amountDueCents: number): FakeInvoice {
    const id = this.nextId('in');
    const invoice: FakeInvoice = {
      id,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      status: 'open',
      amountDueCents,
      amountPaidCents: 0,
      clientSecret: `pi_${id.slice(3)}_secret_fake`,
      created: (this.clock += 1),
    };
    this.invoices.set(sub.id, [...(this.invoices.get(sub.id) ?? []), invoice]);
    return invoice;
  }

  /** Test helper: the subscription's latest invoice. */
  invoiceFor(subscriptionId: string): FakeInvoice | undefined {
    return this.invoices.get(subscriptionId)?.at(-1);
  }

  /** Test helper: the client confirmed a card with the secret — Stripe pays the latest invoice and the subscription goes active. */
  payLatestInvoice(subscriptionId: string): void {
    const invoice = this.invoiceFor(subscriptionId);
    const sub = this.subscriptions.get(subscriptionId);
    if (!invoice || !sub) throw new Error(`No invoice to pay on '${subscriptionId}'`);
    invoice.status = 'paid';
    invoice.amountPaidCents = invoice.amountDueCents;
    sub.status = 'active';
  }

  /** Test helper: a renewal invoice the card failed to pay; the subscription goes `status`. */
  openRenewalInvoice(subscriptionId: string, status: 'past_due' | 'unpaid'): FakeInvoice {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`No such subscription: '${subscriptionId}'`);
    sub.status = status;
    return this.addInvoice(sub, FAKE_BASE_CENTS);
  }

  async latestInvoice(subscriptionId: string): Promise<OrgLatestInvoice | null> {
    this.reads.latestInvoice += 1;
    const invoice = this.invoiceFor(subscriptionId);
    return invoice ? { status: invoice.status, amountDueCents: invoice.status === 'paid' ? 0 : invoice.amountDueCents, clientSecret: invoice.clientSecret } : null;
  }

  async createBillingPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    this.portalSessions.push({ customerId, returnUrl });
    return { url: `https://billing.stripe.test/p/session/${customerId}` };
  }

  async listInvoices(customerId: string, opts: { limit: number; startingAfter?: string }): Promise<{ invoices: OrgInvoiceSummary[]; hasMore: boolean }> {
    this.invoiceListCalls.push({ customerId, limit: opts.limit, startingAfter: opts.startingAfter });
    const all = [...this.invoices.values()].flat().filter((i) => i.customerId === customerId).sort((a, b) => b.created - a.created);
    const from = opts.startingAfter ? all.findIndex((i) => i.id === opts.startingAfter) + 1 : 0;
    const page = all.slice(from, from + opts.limit);
    return {
      invoices: page.map((i) => ({
        id: i.id,
        number: null,
        status: i.status,
        amountDue: i.amountDueCents,
        amountPaid: i.amountPaidCents,
        currency: 'usd',
        created: new Date(i.created * 1000).toISOString(),
        periodStart: null,
        periodEnd: null,
        hostedInvoiceUrl: null,
        invoicePdf: null,
      })),
      hasMore: from + opts.limit < all.length,
    };
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
