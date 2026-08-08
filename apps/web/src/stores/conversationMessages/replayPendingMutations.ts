import type { UIMessage } from 'ai';
import { applyMessageEdit } from '@/lib/ai/streams/applyMessageEdit';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import { applyAskUserAnswer } from '@/lib/ai/streams/applyAskUserAnswer';
import type { PendingMutation } from './seedEmpty';
import { UNVERSIONED_REV } from '@/lib/realtime/conversation-apply';

/**
 * A mutation the snapshot demonstrably already contains: the snapshot was read
 * at `snapshotRev`, which by definition reflects every durable write up to and
 * including that rev, so a mutation stamped at or below it is redundant —
 * and re-applying it would write an OLDER payload over newer truth.
 *
 * Both revs must be real numbers for the comparison to mean anything.
 * `UNVERSIONED_REV` (0) is never "already contained": it means the emitter had
 * no `conversations` row to version, so it proves nothing about ordering and
 * its content must still be replayed.
 */
const isSupersededBySnapshot = (
  mutation: PendingMutation,
  snapshotRev: number | null | undefined,
): boolean =>
  typeof snapshotRev === 'number' &&
  typeof mutation.rev === 'number' &&
  mutation.rev > UNVERSIONED_REV &&
  mutation.rev <= snapshotRev;

/**
 * Replays live mutations recorded during a load's flight onto that load's
 * snapshot, in the order they happened. Reuses `applyMessageEdit`/
 * `applyMessageDelete`. Returns the input `messages` reference unchanged
 * when `pending` is empty.
 *
 * `remoteMessage` (genuine new user message, content never changes) replays as
 * append-if-absent. `confirmedMessage` (an assistant reply confirmation, whose
 * content CAN legitimately supersede a load snapshot's stale/partial copy of
 * the same id) replays as upsert-by-id instead — see `applyConfirmedMessage`.
 *
 * REV-GATED against the snapshot (Agent-Session SSoT epic, Phase 2). Replay
 * exists because there is no ordering guarantee between a fetch and the live
 * events that race it — but "no guarantee" cuts both ways, and a mutation the
 * snapshot already includes must NOT be replayed over it. Consider three writes
 * to one message, delivered out of order:
 *
 *   rev1 create v1 (loaded)  ·  rev2 update→v2  ·  rev3 update→v3
 *   update@3 arrives first   → gap vs watermark 1 → refetch issued (reads rev 3, v3)
 *   update@2 arrives next    → 2 == watermark+1  → applied, and RECORDED as pending
 *   the refetch lands        → without this gate the rev-2 payload replays over the
 *                              rev-3 snapshot, and the watermark folds to 3
 *   ⇒ client: rev 3 / v2     server: rev 3 / v3, and the revs agree forever
 *
 * Passing `snapshotRev` drops exactly those superseded mutations. Omit it (or
 * pass `null`) when the caller has no rev — every mutation replays, which is the
 * pre-existing behavior and still correct for an unversioned snapshot.
 */
export const replayPendingMutations = (
  messages: UIMessage[],
  pending: readonly PendingMutation[],
  snapshotRev?: number | null,
): UIMessage[] => {
  if (pending.length === 0) return messages;

  const applicable = pending.filter((m) => !isSupersededBySnapshot(m, snapshotRev));
  if (applicable.length === 0) return messages;

  return applicable.reduce((acc, mutation) => {
    if (mutation.type === 'remoteMessage') {
      return acc.some((m) => m.id === mutation.message.id) ? acc : [...acc, mutation.message];
    }
    if (mutation.type === 'confirmedMessage') {
      const index = acc.findIndex((m) => m.id === mutation.message.id);
      return index === -1
        ? [...acc, mutation.message]
        : acc.map((m, i) => (i === index ? mutation.message : m));
    }
    if (mutation.type === 'edit') {
      return applyMessageEdit(acc, mutation.payload);
    }
    if (mutation.type === 'askUserAnswer') {
      return applyAskUserAnswer(acc, mutation.payload);
    }
    return applyMessageDelete(acc, mutation.messageId);
  }, messages);
};
