/**
 * CONVERGENCE PROPERTY — the message rev protocol (Agent-Session Single Source
 * of Truth epic, Phase 2; `docs/2.0-architecture/agent-sessions.md` §3 clause 3).
 *
 * The delivery model's whole claim is one sentence:
 *
 *   **Broadcast transport is best-effort; correctness comes from rev + refetch.**
 *
 * The example-based suites next door pin each clause of the apply rule in
 * isolation. This one attacks the claim itself: it generates a random write
 * history on a simulated server, then hands the client an ADVERSARIAL delivery
 * of the resulting events — drops, reorderings, duplicates, truncated payloads,
 * snapshots that come back stale, refetches that resolve after the events they
 * were supposed to heal to — and asserts that once the watermark reconciliation
 * runs, the client holds exactly the server's rows at exactly the server's rev.
 * For every schedule. No transport property is assumed anywhere: the schedule
 * IS the transport, and it is allowed to be as hostile as the wire can be.
 *
 * **Nothing here is mocked, and nothing here is React, a socket, or Postgres.**
 * The client under test is the real pure protocol, wired together in exactly the
 * order `useConversationSubscription` wires it:
 *
 *   `decideConversationApply` → `applyConfirmedMessage` / `applyConversationDelete`
 *   → `advanceRev`, with `applyStartLoad` / `applyLoad` for a refetch.
 *
 * `simulateDelivery` below is a transcription of that hook's `applyMessage` /
 * `handleMessageDeleted` handlers; if the hook's decision wiring ever changes,
 * this file is a lie and must change with it.
 *
 * **Reproducibility.** No fast-check in this repo (checked); the house
 * precedent is a seeded LCG — `packages/lib/src/agent-sessions/__tests__/
 * workspace-layout-verbs.test.ts`'s blob≡rows drift guard. Every schedule is a
 * pure function of one integer seed, and every assertion names the seed that
 * produced it, so a counterexample reproduces by pinning `SEEDS` to that one
 * number. The generators are shrinking-friendly by construction: schedule
 * length, row count and hostility all scale with the seed's own low bits,
 * so low seeds are small, short, near-clean schedules — a failure at seed 3 is
 * already a minimal-ish counterexample, and `describe.each` reports the seed
 * without reading a stack trace.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { decideConversationApply } from '../conversation-apply';
import { applyConfirmedMessage } from '@/stores/conversationMessages/applyConfirmedMessage';
import { applyConversationDelete } from '@/stores/conversationMessages/applyConversationDelete';
import { applyStartLoad } from '@/stores/conversationMessages/applyStartLoad';
import { applyLoad } from '@/stores/conversationMessages/applyLoad';
import { advanceRev } from '@/stores/conversationMessages/advanceRev';
import { seedEmpty, type ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';

const CONVERSATION_ID = 'conv-property';

/** Deterministic LCG — same generator as the layout drift guard, same reason. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// The simulated server: rows + a rev bumped in the same "transaction" as each
// write, exactly as `conversations.rev` is.
// ---------------------------------------------------------------------------

interface ServerRow {
  id: string;
  /** Bumped on every update so a stale copy of a row is detectable, not merely equal. */
  version: number;
}

interface ServerSnapshot {
  messages: UIMessage[];
  rev: number;
}

/** The wire event a write emits, carrying the POST-write rev. */
type WireEvent =
  | { kind: 'created' | 'updated'; rev: number; message: UIMessage; truncated: boolean }
  | { kind: 'deleted'; rev: number; messageId: string };

const toUIMessage = (row: ServerRow): UIMessage => ({
  id: row.id,
  role: 'assistant',
  parts: [{ type: 'text', text: `${row.id}@v${row.version}` }],
});

class SimulatedServer {
  private rows: ServerRow[] = [];
  rev = 0;

  /** A read at THIS instant — what a GET would return, deep-copied so later writes cannot leak in. */
  snapshot(): ServerSnapshot {
    return { messages: this.rows.map(toUIMessage), rev: this.rev };
  }

  create(id: string): WireEvent {
    this.rows.push({ id, version: 1 });
    this.rev += 1;
    return { kind: 'created', rev: this.rev, message: toUIMessage(this.rows[this.rows.length - 1]), truncated: false };
  }

  update(id: string): WireEvent | null {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.version += 1;
    this.rev += 1;
    return { kind: 'updated', rev: this.rev, message: toUIMessage(row), truncated: false };
  }

  remove(id: string): WireEvent | null {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index === -1) return null;
    this.rows.splice(index, 1);
    this.rev += 1;
    return { kind: 'deleted', rev: this.rev, messageId: id };
  }

  ids(): string[] {
    return this.rows.map((r) => r.id);
  }
}

// ---------------------------------------------------------------------------
// The client: the real pure cache, driven the way the subscription hook drives it.
// ---------------------------------------------------------------------------

interface InFlightLoad {
  generation: number;
  /** The rows the GET read — captured when the request was ISSUED, so it can land stale. */
  snapshot: ServerSnapshot;
}

class SimulatedClient {
  byId: ConversationMessagesById = { [CONVERSATION_ID]: seedEmpty() };
  inFlight: InFlightLoad | null = null;
  /** Diagnostics for a failure message — the schedule that produced the state. */
  readonly log: string[] = [];
  /**
   * Set when this run hit the KNOWN OPEN GAP pinned by the `it.fails` case at
   * the bottom of this file: an event OLDER than an in-flight snapshot getting
   * applied during that flight, so `pendingMutationsSinceLoad` replays a stale
   * payload over a newer snapshot. Schedules that reach it are counted and
   * excluded from the convergence property rather than quietly generated away —
   * the exclusion is the finding, and it disappears the day the gap closes.
   */
  staleReplayHazard = false;

  get rev(): number | null {
    return this.byId[CONVERSATION_ID].rev;
  }

  get messages(): UIMessage[] {
    return this.byId[CONVERSATION_ID].messages;
  }

  /**
   * Issue a refetch. COALESCED: `refreshConversationSnapshot` collapses a
   * concurrent refresh for the same conversation onto the one already in
   * flight, so a burst of gap detections is one request — modelled here as a
   * no-op while a load is outstanding. (That coalescing is precisely why
   * `healConversationToRev` needs its bounded second pass; see below.)
   */
  refetch(server: SimulatedServer, why: string): void {
    if (this.inFlight) {
      this.log.push(`refetch(${why}) coalesced onto in-flight load`);
      return;
    }
    const started = applyStartLoad(this.byId, CONVERSATION_ID);
    this.byId = started.byConversationId;
    this.inFlight = { generation: started.generation, snapshot: server.snapshot() };
    this.log.push(`refetch(${why}) issued, read rev ${this.inFlight.snapshot.rev}`);
  }

  /** The response lands. May be arbitrarily stale relative to what has since been applied. */
  settleLoad(): void {
    if (!this.inFlight) return;
    const { generation, snapshot } = this.inFlight;
    this.inFlight = null;
    this.byId = applyLoad(this.byId, {
      conversationId: CONVERSATION_ID,
      generation,
      messages: snapshot.messages,
      rev: snapshot.rev,
    });
    this.log.push(`load settled at rev ${snapshot.rev} -> watermark ${this.rev}`);
  }
}

/**
 * Deliver one event to the client — a transcription of
 * `useConversationSubscription`'s handlers, decision for decision.
 */
function simulateDelivery(client: SimulatedClient, server: SimulatedServer, event: WireEvent): void {
  const truncated = event.kind === 'deleted' ? false : event.truncated;
  const decision = decideConversationApply({ rev: event.rev, truncated }, client.rev);
  client.log.push(`deliver ${event.kind} rev ${event.rev}${truncated ? ' (truncated)' : ''} @wm ${client.rev} -> ${decision}`);
  if (decision === 'drop') return;
  if (decision === 'refetch') {
    client.refetch(server, `${event.kind}@${event.rev}`);
    return;
  }
  if (client.inFlight && event.rev <= client.inFlight.snapshot.rev) {
    // The applied event predates the snapshot already on its way back, so the
    // `pendingMutationsSinceLoad` replay is about to write OLDER content over
    // NEWER truth. See the `it.fails` case below.
    client.staleReplayHazard = true;
    client.log.push(`  ^ STALE-REPLAY HAZARD: rev ${event.rev} <= in-flight snapshot rev ${client.inFlight.snapshot.rev}`);
  }
  if (event.kind === 'deleted') {
    client.byId = applyConversationDelete(client.byId, {
      conversationId: CONVERSATION_ID,
      messageId: event.messageId,
    });
  } else {
    client.byId = applyConfirmedMessage(client.byId, {
      conversationId: CONVERSATION_ID,
      message: event.message,
    });
  }
  client.byId = advanceRev(client.byId, { conversationId: CONVERSATION_ID, rev: event.rev });
}

/**
 * The reconnect watermark check (`syncWatchedConversationRevs` →
 * `healConversationToRev`), reduced to its pure decision: refetch iff the local
 * watermark cannot prove currency, bounded to two passes for exactly the
 * documented reason — the first refetch may ride a coalesced request issued
 * before the write it must heal to.
 */
function reconcileToWatermark(client: SimulatedClient, server: SimulatedServer): void {
  // Whatever was in flight resolves first: awaiting it is what coalescing does.
  client.settleLoad();
  for (let pass = 0; pass < 2; pass += 1) {
    const local = client.rev;
    if (local !== null && local >= server.rev) return;
    client.refetch(server, `watermark-check pass ${pass}`);
    client.settleLoad();
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

interface Schedule {
  /** How many writes the server performs over the run. */
  writes: number;
  /** P(an emitted event is simply never delivered). */
  dropRate: number;
  /** P(an event is delivered a second time). */
  duplicateRate: number;
  /** P(a create/update event arrives as an id-ref instead of a payload). */
  truncateRate: number;
  /** P(the in-flight buffer is flushed in a shuffled order rather than emission order). */
  reorderRate: number;
  /** Whether the client starts from a committed load or from `rev === null`. */
  startsLoaded: boolean;
}

/**
 * Shrinking-friendly: every dimension scales with the seed, so low seeds are
 * short, low-write, near-clean schedules and a low-seed failure is already
 * close to minimal.
 */
function scheduleFor(seed: number): Schedule {
  const rand = prng(seed * 2654435761);
  const scale = Math.min(1, seed / 40);
  return {
    writes: 2 + Math.floor(rand() * (4 + scale * 26)),
    dropRate: rand() * 0.5 * scale,
    duplicateRate: rand() * 0.5 * scale,
    truncateRate: rand() * 0.4 * scale,
    reorderRate: rand() * 0.9 * scale,
    startsLoaded: seed % 5 !== 0,
  };
}

/**
 * Run one schedule end to end. Server writes and deliveries INTERLEAVE on a
 * single timeline, so a refetch reads the rows as they stand at that instant —
 * the only way a stale snapshot, and therefore the `pendingMutationsSinceLoad`
 * replay that defends against it, gets exercised at all.
 */
function runSchedule(seed: number): { client: SimulatedClient; server: SimulatedServer; schedule: Schedule } {
  const schedule = scheduleFor(seed);
  const rand = prng(seed * 7919 + 13);
  const server = new SimulatedServer();
  const client = new SimulatedClient();

  // Prologue: some rows already exist, and the client may already hold them.
  const preexisting = Math.floor(rand() * 3);
  for (let i = 0; i < preexisting; i += 1) server.create(`pre-${i}`);
  if (schedule.startsLoaded) {
    client.refetch(server, 'initial load');
    client.settleLoad();
  }

  /** Events emitted but not yet handed to the client — the wire's in-flight window. */
  let buffer: WireEvent[] = [];
  let minted = 0;

  const flush = (count: number) => {
    if (buffer.length === 0) return;
    const take = Math.min(count, buffer.length);
    const batch = buffer.slice(0, take);
    buffer = buffer.slice(take);
    if (rand() < schedule.reorderRate) {
      // Fisher-Yates: reordering is the wire's, not the emitter's.
      for (let i = batch.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
    }
    for (const event of batch) {
      if (rand() < schedule.dropRate) {
        client.log.push(`DROPPED ${event.kind} rev ${event.rev}`);
        continue;
      }
      simulateDelivery(client, server, event);
      if (rand() < schedule.duplicateRate) simulateDelivery(client, server, event);
    }
  };

  for (let step = 0; step < schedule.writes; step += 1) {
    const roll = rand();
    const existing = server.ids();
    let event: WireEvent | null = null;
    if (roll < 0.5 || existing.length === 0) {
      minted += 1;
      event = server.create(`m-${seed}-${minted}`);
    } else if (roll < 0.8) {
      event = server.update(existing[Math.floor(rand() * existing.length)]);
    } else {
      event = server.remove(existing[Math.floor(rand() * existing.length)]);
    }
    if (event) {
      if (event.kind !== 'deleted' && rand() < schedule.truncateRate) {
        // Over MAX_INLINE_MESSAGE_BYTES: the id-ref rides, the payload does not.
        event = { ...event, truncated: true };
      }
      buffer.push(event);
    }

    // The wire moves at its own pace: sometimes ahead of the writes, sometimes behind.
    if (rand() < 0.6) flush(1 + Math.floor(rand() * 3));
    // An outstanding refetch resolves at an adversarially chosen moment — before,
    // between, or after the events it was supposed to heal to.
    if (client.inFlight && rand() < 0.5) client.settleLoad();
  }

  flush(buffer.length);
  return { client, server, schedule };
}

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

/** 240 schedules — meaningful coverage, still well under a second. */
const SEEDS = Array.from({ length: 240 }, (_, i) => i + 1);

const idsOf = (messages: readonly UIMessage[]): string[] => messages.map((m) => m.id);
const textOf = (message: UIMessage): string =>
  message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('rev protocol convergence (property)', () => {
  it('given any adversarial delivery schedule, should equal DB truth after the watermark check', () => {
    let covered = 0;
    let excluded = 0;
    for (const seed of SEEDS) {
      const { client, server, schedule } = runSchedule(seed);
      if (client.staleReplayHazard) {
        // The one interaction this protocol does NOT yet survive — pinned
        // deterministically by the `it.fails` case below rather than folded in
        // here, so the property stays a statement about what actually holds.
        excluded += 1;
        continue;
      }
      covered += 1;
      reconcileToWatermark(client, server);

      const truth = server.snapshot();
      const where = `seed ${seed} | ${JSON.stringify(schedule)}\n${client.log.join('\n')}`;
      // Rows: same ids, same server order, same CONTENT (versioned, so a stale
      // copy of a row that survived a refetch is a failure, not a pass).
      expect(idsOf(client.messages), where).toEqual(idsOf(truth.messages));
      expect(client.messages.map(textOf), where).toEqual(truth.messages.map(textOf));
      // And the watermark itself is honest: the cache claims exactly the rev it holds.
      expect(client.rev, where).toBe(truth.rev);
    }
    // Guard the guard: a generator that stopped producing hostile schedules —
    // or an exclusion that swallowed most of them — would make the property
    // vacuous. Both ends are asserted.
    expect(covered, 'schedules actually proving convergence').toBeGreaterThan(SEEDS.length * 0.7);
    expect(excluded, 'schedules reaching the known stale-replay gap').toBeGreaterThan(0);
  });

  it('given no reconciliation, should still never claim a watermark it cannot back up', () => {
    // The safety half of the same protocol, and the reason the cheap
    // `localRev >= serverRev` skip in `syncWatchedConversationRevs` is sound:
    // a watermark is only ever reached by applying every write up to it in
    // order, or by adopting a snapshot's own rev. So `watermark >= serverRev`
    // must IMPLY the cache already equals truth — otherwise the reconnect check
    // would skip a conversation that needed healing and heal nothing, forever.
    for (const seed of SEEDS) {
      const { client, server } = runSchedule(seed);
      if (client.staleReplayHazard) continue;
      client.settleLoad();
      const local = client.rev;
      if (local === null || local < server.rev) continue;
      const truth = server.snapshot();
      const where = `seed ${seed}\n${client.log.join('\n')}`;
      expect(idsOf(client.messages), where).toEqual(idsOf(truth.messages));
      expect(client.messages.map(textOf), where).toEqual(truth.messages.map(textOf));
    }
  });

  it('given a duplicated delivery of every event, should be indistinguishable from delivering each once', () => {
    // Idempotency stated directly: `rev <= watermark` drops, and the two cache
    // writers are upsert-by-id and delete-by-id, so redelivery is free.
    for (const seed of SEEDS.slice(0, 60)) {
      const server = new SimulatedServer();
      const rand = prng(seed * 104729);
      const events: WireEvent[] = [];
      let minted = 0;
      for (let i = 0; i < 12; i += 1) {
        const existing = server.ids();
        const roll = rand();
        const event =
          roll < 0.55 || existing.length === 0
            ? server.create(`m-${(minted += 1)}`)
            : roll < 0.85
              ? server.update(existing[Math.floor(rand() * existing.length)])
              : server.remove(existing[Math.floor(rand() * existing.length)]);
        if (event) events.push(event);
      }

      const once = new SimulatedClient();
      const twice = new SimulatedClient();
      for (const client of [once, twice]) {
        client.byId = applyLoad(applyStartLoad(client.byId, CONVERSATION_ID).byConversationId, {
          conversationId: CONVERSATION_ID,
          generation: 1,
          messages: [],
          rev: 0,
        });
      }
      for (const event of events) {
        simulateDelivery(once, server, event);
        simulateDelivery(twice, server, event);
        simulateDelivery(twice, server, event);
        // A third, much later redelivery — the redelivery that arrives after
        // the watermark has moved well past it.
        if (events.length > 0) simulateDelivery(twice, server, events[0]);
      }

      const where = `seed ${seed}\n${twice.log.join('\n')}`;
      expect(idsOf(twice.messages), where).toEqual(idsOf(once.messages));
      expect(twice.rev, where).toBe(once.rev);
    }
  });

  it('given an unversioned emitter (rev 0), should apply content without ever moving a real watermark', () => {
    // Legacy page conversations have no `conversations` row to bump, so their
    // events carry rev 0. Comparing that numerically would drop them forever;
    // adopting it would walk a real watermark back to zero. Neither happens.
    for (const seed of SEEDS.slice(0, 60)) {
      const rand = prng(seed * 40503);
      const client = new SimulatedClient();
      const server = new SimulatedServer();
      // A REAL rev is always >= 1 (the write that emitted the event bumped it);
      // 0 is reserved for "no row to version", which is never a watermark.
      const startRev = 1 + Math.floor(rand() * 20);
      client.byId = applyLoad(applyStartLoad(client.byId, CONVERSATION_ID).byConversationId, {
        conversationId: CONVERSATION_ID,
        generation: 1,
        messages: [],
        rev: startRev,
      });

      const expected: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = `u-${i}`;
        const message: UIMessage = { id, role: 'user', parts: [{ type: 'text', text: id }] };
        simulateDelivery(client, server, { kind: 'created', rev: 0, message, truncated: false });
        expected.push(id);
        // Redelivery of an unversioned event is still a no-op on content (upsert by id).
        if (rand() < 0.5) simulateDelivery(client, server, { kind: 'created', rev: 0, message, truncated: false });
      }

      const where = `seed ${seed} startRev ${startRev}\n${client.log.join('\n')}`;
      expect(idsOf(client.messages), where).toEqual(expected);
      expect(client.rev, where).toBe(startRev);
    }
  });
});

/**
 * ── KNOWN OPEN GAP ────────────────────────────────────────────────────────────
 *
 * Found by the property above (first counterexample: seed 37), minimised here to
 * three writes. `it.fails` asserts the body DOES throw, so this suite stays green
 * while the gap is open and turns RED the moment it is closed — whoever fixes it
 * is forced to come here and promote it to a normal `it`.
 *
 * **The gap.** `applyLoad` replays `pendingMutationsSinceLoad` onto a load's
 * snapshot so a live mutation is never lost to a snapshot that predates it. That
 * replay is REV-BLIND. It assumes every recorded mutation is NEWER than the
 * snapshot — true when events arrive in emission order, false the moment one
 * arrives late: the events are independent HMAC POSTs into the realtime service,
 * which emits them in the order it receives them, so two writes committed
 * microseconds apart can reach a socket in either order.
 *
 * When a late event is applied while a refetch is in flight, its (older) payload
 * is replayed OVER the (newer) snapshot, and `applyLoad`'s own `nextWatermark`
 * then advances the watermark to the snapshot's rev — so the cache holds stale
 * content while CLAIMING to be current. The reconnect watermark check compares
 * revs only (`localRev >= serverRev` → skip), so it never heals this. The
 * divergence is permanent until something unrelated forces a reload.
 *
 * Nothing here is a fix — this file changes no production code. The shape a fix
 * would take (record the rev alongside each `PendingMutation` and let `applyLoad`
 * skip any whose rev is at or below the snapshot's) belongs in the sibling PR
 * that owns `applyLoad`.
 */
describe('KNOWN OPEN GAP: rev-blind pending-mutation replay', () => {
  it.fails('an event applied out of order during an in-flight refetch strands stale content at a current rev', () => {
    const server = new SimulatedServer();
    const client = new SimulatedClient();

    const created = server.create('m1'); // rev 1 — m1@v1
    client.refetch(server, 'initial load');
    client.settleLoad(); // client: [m1@v1] @ rev 1
    expect(client.rev).toBe(1);

    const updateA = server.update('m1'); // rev 2 — m1@v2
    const updateB = server.update('m1'); // rev 3 — m1@v3
    expect(created && updateA && updateB).toBeTruthy();

    // The LATER write is delivered first: watermark 1, rev 3 is a gap, so the
    // client issues a refetch. That read sees rev 3 — the correct, current truth.
    simulateDelivery(client, server, updateB!);
    expect(client.inFlight?.snapshot.rev).toBe(3);

    // The EARLIER write arrives while that GET is in flight. rev 2 == watermark + 1,
    // so the apply rule says apply — correctly, in isolation. It is recorded as a
    // pending mutation carrying the rev-2 payload.
    simulateDelivery(client, server, updateA!);
    expect(client.rev).toBe(2);

    // The GET lands. Its rev-3 snapshot is replayed over with the rev-2 payload,
    // and the watermark is folded up to 3.
    client.settleLoad();
    expect(client.rev).toBe(3);

    // The reconnect check would skip this conversation (3 >= 3), so this is where
    // it stays. THIS is the assertion that currently fails:
    expect(client.messages.map(textOf)).toEqual(server.snapshot().messages.map(textOf));
  });
});
